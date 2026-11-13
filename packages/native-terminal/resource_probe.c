#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include "resource_edge.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#else
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#endif

/* Synthetic allocation/transport proof only. No Ghostty, GPU or Electron import. */
static unsigned checks;
static const char *program;
extern char **environ;
static bool check(bool value,const char *contract) {
  checks++;
  if(!value) fprintf(stderr,"resource-probe: contract failed: %s\n",contract);
  return value;
}
#ifdef __APPLE__
static void field(CFMutableDictionaryRef dictionary,CFStringRef key,int value) {
  CFNumberRef number=CFNumberCreate(NULL,kCFNumberIntType,&value);
  CFDictionarySetValue(dictionary,key,number); CFRelease(number);
}
#endif
static bool allocation(hvir_resource_frame *frame) {
  memset(frame,0,sizeof(*frame));
  frame->metadata=(hvir_resource_metadata){.width=4,.height=4,.premultiplied=1,
    .color_space=1,.origin=1};
#ifdef __APPLE__
  CFMutableDictionaryRef dictionary=CFDictionaryCreateMutable(NULL,0,
    &kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  field(dictionary,kIOSurfaceWidth,4); field(dictionary,kIOSurfaceHeight,4);
  field(dictionary,kIOSurfaceBytesPerElement,4); field(dictionary,kIOSurfaceBytesPerRow,64);
  field(dictionary,kIOSurfacePixelFormat,0x42475241);
  frame->surface=IOSurfaceCreate(dictionary); CFRelease(dictionary);
  if(!frame->surface) return false;
  frame->metadata.kind=1; frame->metadata.fourcc=0x42475241;
  if(IOSurfaceLock(frame->surface,0,NULL)) { hvir_resource_release(frame); return false; }
  memset(IOSurfaceGetBaseAddress(frame->surface),0x6b,IOSurfaceGetAllocSize(frame->surface));
  IOSurfaceUnlock(frame->surface,0,NULL);
#else
  for(unsigned i=0;i<4;i++) frame->fds[i]=-1;
  frame->metadata.kind=2; frame->metadata.fourcc=0x34325258;
  frame->metadata.plane_count=1; frame->metadata.strides[0]=16; frame->metadata.sizes[0]=64;
  frame->fds[0]=memfd_create("hvir-resource-proof",MFD_CLOEXEC);
  uint8_t pixels[64]; memset(pixels,0x6b,sizeof(pixels));
  if(frame->fds[0]<0 || ftruncate(frame->fds[0],64) ||
     pwrite(frame->fds[0],pixels,sizeof(pixels),0)!=(ssize_t)sizeof(pixels)) {
    hvir_resource_release(frame); return false;
  }
#endif
  return true;
}
static bool pixels_match(hvir_resource_frame *frame) {
#ifdef __APPLE__
  if(IOSurfaceLock(frame->surface,kIOSurfaceLockReadOnly,NULL)) return false;
  bool matches=((const uint8_t *)IOSurfaceGetBaseAddress(frame->surface))[0]==0x6b;
  IOSurfaceUnlock(frame->surface,kIOSurfaceLockReadOnly,NULL); return matches;
#else
  uint8_t value=0;
  return pread(frame->fds[0],&value,1,0)==1 && value==0x6b;
#endif
}
static int descriptor_count(void) {
#ifdef __APPLE__
  DIR *directory=opendir("/dev/fd");
#else
  DIR *directory=opendir("/proc/self/fd");
#endif
  if(!directory) return -1;
  int count=0; struct dirent *entry;
  while((entry=readdir(directory))) if(entry->d_name[0]>='0' && entry->d_name[0]<='9') count++;
  closedir(directory); return count;
}
typedef struct { unsigned send,receive; } rights_count;
static bool rights(rights_count *count) {
  memset(count,0,sizeof(*count));
#ifdef __APPLE__
  mach_port_name_array_t names; mach_port_type_array_t types;
  mach_msg_type_number_t name_count=0,type_count=0;
  if(mach_port_names(mach_task_self(),&names,&name_count,&types,&type_count)!=KERN_SUCCESS)
    return false;
  for(unsigned i=0;i<type_count;i++) {
    if(types[i]&MACH_PORT_TYPE_SEND) count->send++;
    if(types[i]&MACH_PORT_TYPE_RECEIVE) count->receive++;
  }
  vm_deallocate(mach_task_self(),(vm_address_t)names,name_count*sizeof(*names));
  vm_deallocate(mach_task_self(),(vm_address_t)types,type_count*sizeof(*types));
#endif
  return true;
}
#ifdef __linux__
static bool malformed_send(const char *address,int expected,const char *ticket,
                            const hvir_resource_frame *frame,const char *mode) {
  int socket_fd=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0);
  if(socket_fd<0) return false;
  struct sockaddr_un local={.sun_family=AF_UNIX};
  if(strlen(address)>=sizeof(local.sun_path)) { close(socket_fd); return false; }
  strcpy(local.sun_path,address);
  bool result=false;
  if(connect(socket_fd,(void *)&local,sizeof(local))) goto done;
  struct ucred peer; socklen_t length=sizeof(peer);
  if(getsockopt(socket_fd,SOL_SOCKET,SO_PEERCRED,&peer,&length) || peer.pid!=expected) goto done;
  /* Intentional malformed wire fixture at the immediate OS adapter boundary. */
  struct { uint32_t magic,version; char ticket[129]; hvir_resource_metadata metadata; } wire={0};
  wire.magic=0x48565246; wire.version=1; strcpy(wire.ticket,ticket); wire.metadata=frame->metadata;
  unsigned count=!strcmp(mode,"extra-rights")?5:1;
  if(!strcmp(mode,"malformed-count")) wire.metadata.plane_count=2;
  char control[CMSG_SPACE(5*sizeof(int))]={0};
  uint8_t payload[sizeof(wire)+1]; memcpy(payload,&wire,sizeof(wire)); payload[sizeof(wire)]=0;
  struct iovec vector={.iov_base=payload,.iov_len=sizeof(wire)+(!strcmp(mode,"truncated"))};
  struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,
    .msg_controllen=CMSG_SPACE(count*sizeof(int))};
  struct cmsghdr *item=CMSG_FIRSTHDR(&message);
  item->cmsg_level=SOL_SOCKET; item->cmsg_type=SCM_RIGHTS; item->cmsg_len=CMSG_LEN(count*sizeof(int));
  int *fds=(void *)CMSG_DATA(item); for(unsigned i=0;i<count;i++) fds[i]=frame->fds[0];
  result=sendmsg(socket_fd,&message,MSG_NOSIGNAL)==(ssize_t)vector.iov_len;
done:
  close(socket_fd); return result;
}
#endif
static int sender(const char *address,int expected,const char *ticket,const char *mode) {
  hvir_resource_frame frame;
  if(!allocation(&frame)) return 70;
  const char *error=NULL; bool result;
#ifdef __linux__
  if(!strcmp(mode,"malformed-count") || !strcmp(mode,"extra-rights") || !strcmp(mode,"truncated"))
    result=malformed_send(address,expected,ticket,&frame,mode);
  else
#endif
    result=hvir_resource_send(address,expected+(!strcmp(mode,"wrong-receiver")),ticket,1000,&frame,&error);
  if(!result && error) fprintf(stderr,"resource-probe: sender %s\n",error);
  hvir_resource_release(&frame); return result?0:71;
}
static bool transfer(unsigned serial) {
  char address[128];
#ifdef __APPLE__
  snprintf(address,sizeof(address),"org.hvir.resource.count.%d.%u",getpid(),serial);
#else
  snprintf(address,sizeof(address),"/tmp/hvir-resource-count-%d-%u.sock",getpid(),serial);
#endif
  hvir_resource_endpoint *endpoint=NULL; const char *error=NULL;
  if(!hvir_resource_endpoint_create(address,&endpoint,&error)) return false;
  char pid[32]; snprintf(pid,sizeof(pid),"%d",getpid());
  char *arguments[]={(char *)program,"--send",address,pid,"owned-right-count",NULL};
  pid_t child=-1;
  const int spawned=posix_spawn(&child,program,NULL,NULL,arguments,environ);
  bool result=false; int status=0;
  if(!spawned && child>0) {
    hvir_resource_frame frame={0};
    result=hvir_resource_receive(endpoint,child,"owned-right-count",2000,&frame,&error);
    if(!result && error) fprintf(stderr,"resource-probe: receiver %s\n",error);
    if(result) result=pixels_match(&frame);
    hvir_resource_release(&frame); hvir_resource_release(&frame);
    if(waitpid(child,&status,0)!=child || !WIFEXITED(status) || WEXITSTATUS(status)) {
      fprintf(stderr,"resource-probe: child status=%d\n",status); result=false;
    }
  }
  hvir_resource_endpoint_revoke(endpoint); hvir_resource_endpoint_free(endpoint);
  return result;
}
static int counts(void) {
  for(unsigned i=0;i<3;i++) if(!check(transfer(i),"warmup-cross-process-transfer")) return 1;
  int before=descriptor_count(); rights_count initial,final;
  if(!check(before>=0 && rights(&initial),"initial-resource-counts")) return 1;
  for(unsigned i=3;i<23;i++) if(!check(transfer(i),"repeated-cross-process-transfer")) return 1;
  if(!check(rights(&final) && before==descriptor_count() && initial.send==final.send &&
            initial.receive==final.receive,"owned-rights-and-descriptors-return-to-baseline")) return 1;
  printf("{\"schema\":1,\"resourceMechanics\":\"passed\",\"checks\":%u,"
    "\"transfers\":23,\"fdCountChecked\":true,\"machRightsChecked\":%s,"
    "\"synthetic\":true,\"hardwareGpuQualified\":false}\n",checks,
#ifdef __APPLE__
    "true"
#else
    "false"
#endif
  );
  return 0;
}
int main(int argc,char **argv) {
  program=argv[0];
  if(argc==2 && !strcmp(argv[1],"--counts")) return counts();
  if((argc==5 || argc==6) && !strcmp(argv[1],"--send")) {
    char *end; long pid=strtol(argv[3],&end,10);
    if(!*argv[3] || *end || pid<=0 || pid>INT32_MAX || !argv[4][0] || strlen(argv[4])>128) return 64;
    const char *mode=argc==6?argv[5]:"normal";
    if(strcmp(mode,"normal") && strcmp(mode,"wrong-receiver") && strcmp(mode,"malformed-count") &&
       strcmp(mode,"extra-rights") && strcmp(mode,"truncated")) return 64;
    return sender(argv[2],(int)pid,argv[4],mode);
  }
  return 64;
}
