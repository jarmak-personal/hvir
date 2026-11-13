#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#include "resource_edge.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <bsm/libbsm.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct hvir_resource_endpoint { mach_port_t port; atomic_bool closing; };
enum { HELLO=0x485601, ACK=0x485602, FRAME=0x485603 };
typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t right;
  uint32_t version;
  char ticket[HVIR_RESOURCE_TICKET_MAX+1];
  hvir_resource_metadata metadata;
} resource_message;
typedef struct { resource_message message; mach_msg_max_trailer_t trailer; } received_message;
static bool fail(const char **error,const char *label) { *error=label; return false; }
static uint64_t milliseconds(void) {
  struct timespec time; clock_gettime(CLOCK_MONOTONIC,&time);
  return (uint64_t)time.tv_sec*1000+(uint64_t)time.tv_nsec/1000000;
}
void hvir_resource_release(hvir_resource_frame *frame) {
  if(frame->metadata.kind==1 && frame->surface) CFRelease(frame->surface);
  memset(frame,0,sizeof(*frame));
}
bool hvir_resource_snapshot(const hvir_resource_frame *source,hvir_resource_frame *copy,
                            const char **error) {
  memset(copy,0,sizeof(*copy));
  if(source->metadata.kind!=1 || !source->surface || source->metadata.plane_count ||
     !source->metadata.width || source->metadata.width>8192 ||
     !source->metadata.height || source->metadata.height>8192 ||
     source->metadata.premultiplied>1 || !source->metadata.color_space ||
     source->metadata.color_space>2 || !source->metadata.origin || source->metadata.origin>2)
    return fail(error,"resource-kind-or-surface-invalid");
  IOSurfaceRef surface=source->surface;
  if(IOSurfaceGetWidth(surface)!=source->metadata.width ||
     IOSurfaceGetHeight(surface)!=source->metadata.height ||
     IOSurfaceGetPixelFormat(surface)!=source->metadata.fourcc)
    return fail(error,"resource-surface-metadata-invalid");
  *copy=*source; CFRetain(surface); return true;
}
bool hvir_resource_endpoint_create(const char *address,hvir_resource_endpoint **out,
                                   const char **error) {
  *out=NULL;
  if(!address[0] || strlen(address)>=HVIR_RESOURCE_ADDRESS_MAX)
    return fail(error,"resource-address-invalid");
  hvir_resource_endpoint *endpoint=calloc(1,sizeof(*endpoint));
  if(!endpoint) return fail(error,"resource-allocation-failed");
  /* Public bootstrap rendezvous, not Chromium private symbols or a plist. */
  if(bootstrap_check_in(bootstrap_port,address,&endpoint->port)!=KERN_SUCCESS) {
    free(endpoint); return fail(error,"resource-endpoint-create-failed");
  }
  mach_port_limits_t limits={.mpl_qlimit=2};
  if(mach_port_set_attributes(mach_task_self(),endpoint->port,MACH_PORT_LIMITS_INFO,
      (mach_port_info_t)&limits,MACH_PORT_LIMITS_INFO_COUNT)!=KERN_SUCCESS) {
    mach_port_mod_refs(mach_task_self(),endpoint->port,MACH_PORT_RIGHT_RECEIVE,-1); free(endpoint);
    return fail(error,"resource-endpoint-limit-failed");
  }
  atomic_init(&endpoint->closing,false); *out=endpoint; return true;
}
void hvir_resource_endpoint_revoke(hvir_resource_endpoint *endpoint) {
  atomic_store(&endpoint->closing,true);
}
void hvir_resource_endpoint_free(hvir_resource_endpoint *endpoint) {
  if(!endpoint) return;
  mach_port_mod_refs(mach_task_self(),endpoint->port,MACH_PORT_RIGHT_RECEIVE,-1); free(endpoint);
}
static bool receive_message(mach_port_t port,uint64_t deadline,atomic_bool *closing,
                             received_message *received,const char **error) {
  while(milliseconds()<deadline) {
    if(closing && atomic_load(closing)) return fail(error,"endpoint-closed");
    memset(received,0,sizeof(*received));
    uint64_t now=milliseconds(); if(now>=deadline) break;
    mach_msg_timeout_t timeout=(mach_msg_timeout_t)(deadline-now<50?deadline-now:50);
    mach_msg_return_t result=mach_msg(&received->message.header,
      MACH_RCV_MSG|MACH_RCV_TIMEOUT|MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)|
      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),0,sizeof(*received),port,timeout,
      MACH_PORT_NULL);
    if(result==MACH_RCV_TIMED_OUT || result==MACH_RCV_INTERRUPTED) continue;
    if(result!=MACH_MSG_SUCCESS) return fail(error,"resource-receive-failed");
    return true;
  }
  return fail(error,"resource-timeout");
}
static bool authenticate(received_message *received,int pid,int kind,const char *ticket,
                          const char **error) {
  resource_message *message=&received->message;
  if(message->header.msgh_size!=sizeof(*message) || message->header.msgh_id!=kind ||
     message->version!=1 || !memchr(message->ticket,0,sizeof(message->ticket)) ||
     strcmp(ticket,message->ticket)) return fail(error,"resource-message-rejected");
  const mach_msg_audit_trailer_t *trailer=(void *)((char *)message+
    round_msg(message->header.msgh_size));
  if(trailer->msgh_trailer_type!=MACH_MSG_TRAILER_FORMAT_0 ||
     trailer->msgh_trailer_size<sizeof(*trailer) ||
     audit_token_to_pid(trailer->msgh_audit)!=pid ||
     audit_token_to_euid(trailer->msgh_audit)!=geteuid())
    return fail(error,"resource-peer-rejected");
  return true;
}
static bool send_message(resource_message *message,uint64_t deadline,const char **error) {
  uint64_t now=milliseconds();
  if(now>=deadline) return fail(error,"resource-timeout");
  return mach_msg(&message->header,MACH_SEND_MSG|MACH_SEND_TIMEOUT,
    sizeof(*message),0,MACH_PORT_NULL,(mach_msg_timeout_t)(deadline-now),MACH_PORT_NULL)
    ==MACH_MSG_SUCCESS || fail(error,"resource-send-failed");
}
static resource_message message_for(mach_port_t target,int kind,const char *ticket) {
  resource_message message={0};
  message.header.msgh_bits=MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0);
  message.header.msgh_remote_port=target;
  message.header.msgh_size=sizeof(message); message.header.msgh_id=kind;
  message.version=1; strcpy(message.ticket,ticket); return message;
}
bool hvir_resource_receive(hvir_resource_endpoint *endpoint,int expected,const char *ticket,
                           uint32_t timeout,hvir_resource_frame *out,const char **error) {
  const uint64_t deadline=milliseconds()+timeout;
  received_message received;
  if(!receive_message(endpoint->port,deadline,&endpoint->closing,&received,error)) return false;
  resource_message *hello=&received.message;
  bool accepted=authenticate(&received,expected,HELLO,ticket,error) &&
    (hello->header.msgh_bits&MACH_MSGH_BITS_COMPLEX) && hello->body.msgh_descriptor_count==1 &&
    hello->right.type==MACH_MSG_PORT_DESCRIPTOR && hello->right.name!=MACH_PORT_NULL &&
    hello->right.disposition==MACH_MSG_TYPE_PORT_SEND;
  if(accepted) {
    resource_message ack=message_for(hello->right.name,ACK,ticket);
    accepted=send_message(&ack,deadline,error);
  } else if(!*error) fail(error,"resource-hello-rejected");
  mach_msg_destroy(&hello->header);
  if(!accepted) return false;
  if(!receive_message(endpoint->port,deadline,&endpoint->closing,&received,error)) return false;
  resource_message *frame=&received.message;
  accepted=authenticate(&received,expected,FRAME,ticket,error) &&
    (frame->header.msgh_bits&MACH_MSGH_BITS_COMPLEX) && frame->body.msgh_descriptor_count==1 &&
    frame->right.type==MACH_MSG_PORT_DESCRIPTOR && frame->right.name!=MACH_PORT_NULL &&
    frame->right.disposition==MACH_MSG_TYPE_PORT_SEND && frame->metadata.kind==1 &&
    !frame->metadata.plane_count && frame->metadata.width && frame->metadata.width<=8192 &&
    frame->metadata.height && frame->metadata.height<=8192;
  if(accepted) {
    IOSurfaceRef surface=IOSurfaceLookupFromMachPort(frame->right.name);
    if(!surface) accepted=fail(error,"resource-surface-lookup-failed");
    else {
      hvir_resource_frame local={.metadata=frame->metadata,.surface=surface};
      accepted=hvir_resource_snapshot(&local,out,error); CFRelease(surface);
    }
  } else if(!*error) fail(error,"resource-frame-rejected");
  /* Destroy received Mach rights separately from receiver-owned IOSurface refs. */
  mach_msg_destroy(&frame->header);
  if(accepted && atomic_load(&endpoint->closing)) {
    hvir_resource_release(out); return fail(error,"endpoint-closed");
  }
  return accepted;
}
bool hvir_resource_send(const char *address,int expected,const char *ticket,uint32_t timeout,
                        const hvir_resource_frame *frame,const char **error) {
  if(frame->metadata.kind!=1 || !frame->surface)
    return fail(error,"resource-kind-or-surface-invalid");
  const uint64_t deadline=milliseconds()+timeout;
  mach_port_t server=MACH_PORT_NULL,reply=MACH_PORT_NULL,surface=MACH_PORT_NULL;
  bool success=false;
  if(bootstrap_look_up(bootstrap_port,address,&server)!=KERN_SUCCESS)
    return fail(error,"resource-lookup-failed");
  if(mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&reply)!=KERN_SUCCESS) {
    fail(error,"resource-reply-port-failed"); goto done;
  }
  resource_message hello=message_for(server,HELLO,ticket);
  hello.header.msgh_bits|=MACH_MSGH_BITS_COMPLEX; hello.body.msgh_descriptor_count=1;
  hello.right=(mach_msg_port_descriptor_t){.name=reply,.disposition=MACH_MSG_TYPE_MAKE_SEND,
    .type=MACH_MSG_PORT_DESCRIPTOR};
  if(!send_message(&hello,deadline,error)) goto done;
  received_message ack;
  if(!receive_message(reply,deadline,NULL,&ack,error)) goto done;
  bool authenticated=authenticate(&ack,expected,ACK,ticket,error) &&
    !(ack.message.header.msgh_bits&MACH_MSGH_BITS_COMPLEX);
  mach_msg_destroy(&ack.message.header);
  if(!authenticated) { if(!*error) fail(error,"resource-ack-rejected"); goto done; }
  surface=IOSurfaceCreateMachPort(frame->surface);
  if(surface==MACH_PORT_NULL) { fail(error,"resource-surface-right-failed"); goto done; }
  resource_message payload=message_for(server,FRAME,ticket);
  payload.header.msgh_bits|=MACH_MSGH_BITS_COMPLEX; payload.body.msgh_descriptor_count=1;
  payload.metadata=frame->metadata;
  payload.right=(mach_msg_port_descriptor_t){.name=surface,.disposition=MACH_MSG_TYPE_MOVE_SEND,
    .type=MACH_MSG_PORT_DESCRIPTOR};
  success=send_message(&payload,deadline,error);
  if(success) surface=MACH_PORT_NULL;
done:
  if(surface!=MACH_PORT_NULL) mach_port_deallocate(mach_task_self(),surface);
  if(reply!=MACH_PORT_NULL) mach_port_mod_refs(mach_task_self(),reply,MACH_PORT_RIGHT_RECEIVE,-1);
  mach_port_deallocate(mach_task_self(),server); return success;
}
#endif
