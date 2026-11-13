#ifdef __linux__
#define _GNU_SOURCE
#include "resource_edge.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

struct hvir_resource_endpoint { int socket; atomic_bool closing; char address[108]; };
typedef struct {
  uint32_t magic, version;
  char ticket[HVIR_RESOURCE_TICKET_MAX + 1];
  hvir_resource_metadata metadata;
} wire_frame;
static uint64_t milliseconds(void) {
  struct timespec time; clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static bool fail(const char **error, const char *label) { *error = label; return false; }
static bool ready(int fd, short events, uint64_t deadline, atomic_bool *closing,
                  const char **error) {
  while (milliseconds() < deadline) {
    if (closing && atomic_load(closing)) return fail(error, "endpoint-closed");
    struct pollfd item = {.fd=fd,.events=events};
    uint64_t now=milliseconds(); if(now>=deadline) break;
    uint64_t remaining = deadline - now;
    int result = poll(&item, 1, (int)(remaining < 50 ? remaining : 50));
    if (result > 0 && (item.revents & events)) return true;
    if (result > 0 && (item.revents & (POLLERR|POLLHUP|POLLNVAL)))
      return fail(error, "resource-peer-closed");
    if (result < 0 && errno != EINTR) return fail(error, "resource-poll-failed");
  }
  return fail(error, "resource-timeout");
}
static bool peer(int fd, int expected, const char **error) {
  struct ucred credentials; socklen_t size=sizeof(credentials);
  return (getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&credentials,&size)==0 &&
          size==sizeof(credentials) && credentials.pid==expected && credentials.uid==getuid()) ||
    fail(error,"resource-peer-rejected");
}
void hvir_resource_release(hvir_resource_frame *frame) {
  if (frame->metadata.kind==2)
    for (unsigned i=0;i<4;i++) if (frame->fds[i]>=0) close(frame->fds[i]);
  memset(frame,0,sizeof(*frame));
  for(unsigned i=0;i<4;i++) frame->fds[i]=-1;
}
static bool allocation(int fd, uint64_t *size) {
  struct stat stat; if (fstat(fd,&stat)) return false;
  off_t length=stat.st_size;
  if (length<=0) length=lseek(fd,0,SEEK_END);
  if(length<=0) return false;
  *size=(uint64_t)length; return true;
}
bool hvir_resource_snapshot(const hvir_resource_frame *source, hvir_resource_frame *copy,
                            const char **error) {
  memset(copy,0,sizeof(*copy)); copy->metadata=source->metadata;
  for(unsigned i=0;i<4;i++) copy->fds[i]=-1;
  if(source->metadata.kind!=2 || !source->metadata.plane_count || source->metadata.plane_count>4 ||
     !source->metadata.width || source->metadata.width>8192 ||
     !source->metadata.height || source->metadata.height>8192 ||
     source->metadata.premultiplied>1 || !source->metadata.color_space ||
     source->metadata.color_space>2 || !source->metadata.origin || source->metadata.origin>2)
    return fail(error,"resource-kind-or-plane-count");
  for(unsigned i=0;i<source->metadata.plane_count;i++) {
    copy->fds[i]=fcntl(source->fds[i],F_DUPFD_CLOEXEC,0);
    uint64_t size=0;
    if(copy->fds[i]<0 || !allocation(copy->fds[i],&size) ||
       !copy->metadata.strides[i] || copy->metadata.sizes[i]!=size ||
       (uint64_t)copy->metadata.offsets[i]+copy->metadata.strides[i]>size) {
      hvir_resource_release(copy); return fail(error,"resource-plane-invalid");
    }
  }
  return true;
}
bool hvir_resource_endpoint_create(const char *address, hvir_resource_endpoint **out,
                                   const char **error) {
  *out=NULL;
  if(!address[0] || strlen(address)>=sizeof(((struct sockaddr_un *)0)->sun_path))
    return fail(error,"resource-address-invalid");
  hvir_resource_endpoint *endpoint=calloc(1,sizeof(*endpoint));
  if(!endpoint) return fail(error,"resource-allocation-failed");
  endpoint->socket=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
  struct sockaddr_un local={.sun_family=AF_UNIX}; strcpy(local.sun_path,address);
  /* Never unlink a caller-selected existing entry. Main supplies a private path. */
  bool bound=false;
  if(endpoint->socket>=0) bound=bind(endpoint->socket,(void *)&local,sizeof(local))==0;
  if(!bound || chmod(address,0600) || listen(endpoint->socket,1)) {
    if(endpoint->socket>=0) close(endpoint->socket);
    if(bound) unlink(address);
    free(endpoint); return fail(error,"resource-endpoint-create-failed");
  }
  strcpy(endpoint->address,address); atomic_init(&endpoint->closing,false);
  *out=endpoint; return true;
}
void hvir_resource_endpoint_revoke(hvir_resource_endpoint *endpoint) {
  atomic_store(&endpoint->closing,true);
}
void hvir_resource_endpoint_free(hvir_resource_endpoint *endpoint) {
  if(!endpoint) return;
  close(endpoint->socket); unlink(endpoint->address); free(endpoint);
}
bool hvir_resource_receive(hvir_resource_endpoint *endpoint,int expected,const char *ticket,
                           uint32_t timeout,hvir_resource_frame *out,const char **error) {
  const uint64_t deadline=milliseconds()+timeout;
  if(!ready(endpoint->socket,POLLIN,deadline,&endpoint->closing,error)) return false;
  int connection=accept4(endpoint->socket,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
  if(connection<0) return fail(error,"resource-accept-failed");
  bool success=false;
  wire_frame wire={0};
  char ancillary[CMSG_SPACE(4*sizeof(int))]={0};
  struct iovec vector={.iov_base=&wire,.iov_len=sizeof(wire)};
  struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,
    .msg_control=ancillary,.msg_controllen=sizeof(ancillary)};
  int received[4]={-1,-1,-1,-1}; unsigned count=0;
  if(!peer(connection,expected,error) ||
     !ready(connection,POLLIN,deadline,&endpoint->closing,error)) goto done;
  ssize_t length=recvmsg(connection,&message,MSG_CMSG_CLOEXEC);
  bool malformed=false;
  for(struct cmsghdr *item=CMSG_FIRSTHDR(&message);item;item=CMSG_NXTHDR(&message,item)) {
    if(item->cmsg_level!=SOL_SOCKET || item->cmsg_type!=SCM_RIGHTS ||
       item->cmsg_len<CMSG_LEN(0)) { malformed=true; continue; }
    size_t bytes=item->cmsg_len-CMSG_LEN(0);
    if(bytes%sizeof(int)) malformed=true;
    const int *fds=(void *)CMSG_DATA(item);
    for(size_t i=0;i<bytes/sizeof(int);i++) {
      if(count<4) received[count++]=fds[i]; else { close(fds[i]); malformed=true; }
    }
  }
  if(length!=(ssize_t)sizeof(wire) || (message.msg_flags&(MSG_CTRUNC|MSG_TRUNC)) ||
     malformed || wire.magic!=0x48565246 || wire.version!=1 ||
     !memchr(wire.ticket,0,sizeof(wire.ticket)) || strcmp(wire.ticket,ticket) ||
     wire.metadata.kind!=2 || !count || count!=wire.metadata.plane_count ||
     !wire.metadata.width || wire.metadata.width>8192 || !wire.metadata.height ||
     wire.metadata.height>8192) { fail(error,"resource-message-rejected"); goto done; }
  hvir_resource_frame source={.metadata=wire.metadata};
  for(unsigned i=0;i<4;i++) source.fds[i]=received[i];
  success=hvir_resource_snapshot(&source,out,error);
done:
  for(unsigned i=0;i<count;i++) if(received[i]>=0) close(received[i]);
  close(connection);
  if(success && atomic_load(&endpoint->closing)) {
    hvir_resource_release(out); return fail(error,"endpoint-closed");
  }
  return success;
}
bool hvir_resource_send(const char *address,int expected,const char *ticket,uint32_t timeout,
                        const hvir_resource_frame *frame,const char **error) {
  if(frame->metadata.kind!=2 || !frame->metadata.plane_count || frame->metadata.plane_count>4)
    return fail(error,"resource-kind-or-plane-count");
  if(strlen(address)>=sizeof(((struct sockaddr_un *)0)->sun_path))
    return fail(error,"resource-address-invalid");
  int connection=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
  if(connection<0) return fail(error,"resource-connect-failed");
  bool success=false; uint64_t deadline=milliseconds()+timeout;
  struct sockaddr_un local={.sun_family=AF_UNIX}; strcpy(local.sun_path,address);
  if(connect(connection,(void *)&local,sizeof(local)) && errno!=EINPROGRESS)
    { fail(error,"resource-connect-failed"); goto done; }
  if(!ready(connection,POLLOUT,deadline,NULL,error) || !peer(connection,expected,error)) goto done;
  wire_frame wire={.magic=0x48565246,.version=1,.metadata=frame->metadata};
  strcpy(wire.ticket,ticket);
  char ancillary[CMSG_SPACE(4*sizeof(int))]={0};
  struct iovec vector={.iov_base=&wire,.iov_len=sizeof(wire)};
  struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,
    .msg_control=ancillary,.msg_controllen=CMSG_SPACE(frame->metadata.plane_count*sizeof(int))};
  struct cmsghdr *rights=CMSG_FIRSTHDR(&message);
  rights->cmsg_level=SOL_SOCKET; rights->cmsg_type=SCM_RIGHTS;
  rights->cmsg_len=CMSG_LEN(frame->metadata.plane_count*sizeof(int));
  memcpy(CMSG_DATA(rights),frame->fds,frame->metadata.plane_count*sizeof(int));
  success=sendmsg(connection,&message,MSG_NOSIGNAL)==(ssize_t)sizeof(wire);
  if(!success) fail(error,"resource-send-failed");
done:
  close(connection); return success;
}
#endif
