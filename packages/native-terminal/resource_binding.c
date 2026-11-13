#define NAPI_VERSION 8
#include <node_api.h>
#include "resource_edge.h"
#include <stdlib.h>
#include <string.h>

/* This addon owns OS references only. It never loads or links Ghostty. Each
 * accepted send snapshots producer references before handing work to a worker. */
typedef struct {
  hvir_resource_endpoint *native;
  bool receiving, closed, counted;
  napi_deferred close_deferred;
  napi_ref close_owner, close_promise;
} endpoint_binding;
typedef struct { hvir_resource_frame frame; bool released; } receipt_binding;
typedef enum { CREATE, RECEIVE, SEND } operation;
typedef struct {
  operation operation;
  napi_async_work work;
  napi_deferred deferred;
  napi_ref owner;
  endpoint_binding *endpoint;
  hvir_resource_endpoint *created;
  hvir_resource_frame frame;
  char address[HVIR_RESOURCE_ADDRESS_MAX], ticket[HVIR_RESOURCE_TICKET_MAX+1];
  int pid;
  uint32_t timeout;
  bool success;
  const char *error;
} resource_job;
static atomic_uint jobs, endpoints;
static const napi_type_tag endpoint_tag={0x4856495245503031,0x5245534f55524345};
static const napi_type_tag receipt_tag={0x4856495252433031,0x5245534f55524345};
static napi_value invalid(napi_env env,const char *message) {
  napi_throw_type_error(env,NULL,message); return NULL;
}
static bool property(napi_env env,napi_value object,const char *key,napi_value *value) {
  return napi_get_named_property(env,object,key,value)==napi_ok;
}
static bool integer(napi_env env,napi_value value,uint32_t max,uint32_t *out) {
  double number;
  if(napi_get_value_double(env,value,&number)!=napi_ok || !(number>=0 && number<=max)) return false;
  *out=(uint32_t)number; return number==*out;
}
static bool number_property(napi_env env,napi_value object,const char *key,uint32_t max,uint32_t *out) {
  napi_value value; return property(env,object,key,&value) && integer(env,value,max,out);
}
static bool bigint(napi_env env,napi_value object,const char *key,uint64_t *out) {
  napi_value value; bool exact=false;
  return property(env,object,key,&value) &&
    napi_get_value_bigint_uint64(env,value,out,&exact)==napi_ok && exact;
}
static bool boolean_property(napi_env env,napi_value object,const char *key,uint32_t *out) {
  napi_value value; bool boolean;
  if(!property(env,object,key,&value) || napi_get_value_bool(env,value,&boolean)!=napi_ok) return false;
  *out=boolean; return true;
}
static bool string(napi_env env,napi_value value,char *out,size_t capacity) {
  size_t length=0;
  if(napi_get_value_string_utf8(env,value,NULL,0,&length)!=napi_ok || !length || length>=capacity)
    return false;
  if(napi_get_value_string_utf8(env,value,out,capacity,&length)!=napi_ok) return false;
  for(size_t i=0;i<length;i++) if((unsigned char)out[i]<33 || (unsigned char)out[i]>126) return false;
  return true;
}
static void *unwrap(napi_env env,napi_value object,const napi_type_tag *tag) {
  bool matches=false; void *value=NULL;
  if(napi_check_object_type_tag(env,object,tag,&matches)!=napi_ok || !matches ||
     napi_unwrap(env,object,&value)!=napi_ok) return NULL;
  return value;
}
static void settle_close(napi_env env,endpoint_binding *endpoint) {
  hvir_resource_endpoint_free(endpoint->native); endpoint->native=NULL;
  if(endpoint->counted) { endpoint->counted=false; atomic_fetch_sub(&endpoints,1); }
  if(endpoint->close_deferred) {
    napi_value undefined; napi_get_undefined(env,&undefined);
    napi_resolve_deferred(env,endpoint->close_deferred,undefined);
    endpoint->close_deferred=NULL;
    napi_delete_reference(env,endpoint->close_owner); endpoint->close_owner=NULL;
    napi_delete_reference(env,endpoint->close_promise); endpoint->close_promise=NULL;
  }
}
static void endpoint_finalizer(napi_env env,void *data,void *hint) {
  (void)env; (void)hint; endpoint_binding *endpoint=data;
  hvir_resource_endpoint_free(endpoint->native);
  if(endpoint->counted) atomic_fetch_sub(&endpoints,1);
  free(endpoint);
}
static void receipt_finalizer(napi_env env,void *data,void *hint) {
  (void)env; (void)hint; receipt_binding *receipt=data;
  if(!receipt->released) hvir_resource_release(&receipt->frame);
  free(receipt);
}
static bool set_number(napi_env env,napi_value object,const char *name,uint32_t number) {
  napi_value value; return napi_create_uint32(env,number,&value)==napi_ok &&
    napi_set_named_property(env,object,name,value)==napi_ok;
}
static bool set_bigint(napi_env env,napi_value object,const char *name,uint64_t number) {
  napi_value value; return napi_create_bigint_uint64(env,number,&value)==napi_ok &&
    napi_set_named_property(env,object,name,value)==napi_ok;
}
static napi_value receipt_object(napi_env env,resource_job *job) {
  receipt_binding *receipt=calloc(1,sizeof(*receipt));
  if(!receipt) return NULL;
  receipt->frame=job->frame;
  napi_value object,planes,ticket;
  if(napi_create_object(env,&object)!=napi_ok ||
     napi_type_tag_object(env,object,&receipt_tag)!=napi_ok ||
     napi_wrap(env,object,receipt,receipt_finalizer,NULL,NULL)!=napi_ok) {
    free(receipt); return NULL;
  }
  /* Ownership moves only once the wrapper finalizer is installed. */
  memset(&job->frame,0,sizeof(job->frame));
  const hvir_resource_metadata *metadata=&receipt->frame.metadata;
  napi_create_string_utf8(env,job->ticket,NAPI_AUTO_LENGTH,&ticket);
  napi_set_named_property(env,object,"ticket",ticket);
  set_number(env,object,"kind",metadata->kind);
  set_number(env,object,"width",metadata->width); set_number(env,object,"height",metadata->height);
  set_number(env,object,"fourcc",metadata->fourcc);
  napi_value premultiplied; napi_get_boolean(env,metadata->premultiplied!=0,&premultiplied);
  napi_set_named_property(env,object,"premultiplied",premultiplied);
  set_number(env,object,"colorSpace",metadata->color_space); set_number(env,object,"origin",metadata->origin);
  set_bigint(env,object,"modifier",metadata->modifier);
  set_number(env,object,"planeCount",metadata->plane_count);
  napi_create_array_with_length(env,metadata->plane_count,&planes);
  for(uint32_t i=0;i<metadata->plane_count;i++) {
    napi_value plane; napi_create_object(env,&plane);
    set_number(env,plane,"fd",(uint32_t)receipt->frame.fds[i]);
    set_number(env,plane,"stride",metadata->strides[i]); set_number(env,plane,"offset",metadata->offsets[i]);
    set_bigint(env,plane,"size",metadata->sizes[i]); napi_set_element(env,planes,i,plane);
  }
  napi_set_named_property(env,object,"planes",planes);
  if(metadata->kind==1) {
    napi_value surface;
    napi_create_buffer_copy(env,sizeof(receipt->frame.surface),&receipt->frame.surface,NULL,&surface);
    napi_set_named_property(env,object,"surface",surface);
  }
  return object;
}
static void execute(napi_env env,void *data) {
  (void)env; resource_job *job=data;
  if(job->operation==CREATE)
    job->success=hvir_resource_endpoint_create(job->address,&job->created,&job->error);
  else if(job->operation==RECEIVE)
    job->success=hvir_resource_receive(job->endpoint->native,job->pid,job->ticket,
      job->timeout,&job->frame,&job->error);
  else job->success=hvir_resource_send(job->address,job->pid,job->ticket,
    job->timeout,&job->frame,&job->error);
}
static void complete(napi_env env,napi_status status,void *data) {
  resource_job *job=data; napi_value value=NULL;
  atomic_fetch_sub(&jobs,1);
  if(job->operation==RECEIVE) {
    job->endpoint->receiving=false;
    if(job->endpoint->closed) { job->success=false; job->error="endpoint-closed"; }
  }
  if(status!=napi_ok) { job->success=false; job->error="resource-work-cancelled"; }
  if(job->success && job->operation==CREATE) {
    endpoint_binding *endpoint=calloc(1,sizeof(*endpoint));
    if(endpoint && napi_create_object(env,&value)==napi_ok &&
       napi_type_tag_object(env,value,&endpoint_tag)==napi_ok &&
       napi_wrap(env,value,endpoint,endpoint_finalizer,NULL,NULL)==napi_ok) {
      endpoint->native=job->created; endpoint->counted=true; job->created=NULL;
    } else { free(endpoint); value=NULL; job->error="resource-allocation-failed"; }
  } else if(job->success && job->operation==RECEIVE) value=receipt_object(env,job);
  else if(job->success) napi_get_undefined(env,&value);
  if(!value) {
    napi_value message,error;
    napi_create_string_utf8(env,job->error?job->error:"resource-allocation-failed",NAPI_AUTO_LENGTH,&message);
    napi_create_error(env,NULL,message,&error); napi_reject_deferred(env,job->deferred,error);
  } else napi_resolve_deferred(env,job->deferred,value);
  if(job->operation==CREATE && job->created) hvir_resource_endpoint_free(job->created);
  if(job->operation==CREATE && !value) atomic_fetch_sub(&endpoints,1);
  hvir_resource_release(&job->frame);
  if(job->endpoint && job->endpoint->closed) settle_close(env,job->endpoint);
  if(job->owner) napi_delete_reference(env,job->owner);
  napi_delete_async_work(env,job->work); free(job);
}
static napi_value queue(napi_env env,resource_job *job) {
  if(atomic_fetch_add(&jobs,1)>=8) {
    atomic_fetch_sub(&jobs,1);
    if(job->operation==CREATE) atomic_fetch_sub(&endpoints,1);
    if(job->endpoint) job->endpoint->receiving=false;
    if(job->owner) napi_delete_reference(env,job->owner);
    hvir_resource_release(&job->frame); free(job);
    return invalid(env,"resource-job-bound");
  }
  napi_value promise,name;
  napi_create_promise(env,&job->deferred,&promise);
  napi_create_string_utf8(env,"hvir-resource-transfer",NAPI_AUTO_LENGTH,&name);
  if(napi_create_async_work(env,NULL,name,execute,complete,job,&job->work)!=napi_ok ||
     napi_queue_async_work(env,job->work)!=napi_ok) {
    complete(env,napi_cancelled,job);
  }
  return promise;
}
static napi_value create_endpoint(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value arguments[1]; napi_get_cb_info(env,info,&count,arguments,NULL,NULL);
  resource_job *job=calloc(1,sizeof(*job)); if(!job) return invalid(env,"resource-allocation-failed");
  job->operation=CREATE;
  if(count!=1 || !string(env,arguments[0],job->address,sizeof(job->address)))
    { free(job); return invalid(env,"resource-address-invalid"); }
  if(atomic_fetch_add(&endpoints,1)>=16) {
    atomic_fetch_sub(&endpoints,1); free(job); return invalid(env,"resource-endpoint-bound");
  }
  return queue(env,job);
}
static napi_value receive_frame(napi_env env,napi_callback_info info) {
  size_t count=4; napi_value arguments[4]; napi_get_cb_info(env,info,&count,arguments,NULL,NULL);
  if(count!=4) return invalid(env,"resource-receive-arguments");
  endpoint_binding *endpoint=unwrap(env,arguments[0],&endpoint_tag);
  if(!endpoint || endpoint->closed || endpoint->receiving)
    return invalid(env,"resource-endpoint-closed-or-busy");
  resource_job *job=calloc(1,sizeof(*job)); if(!job) return invalid(env,"resource-allocation-failed");
  uint32_t pid;
  if(!integer(env,arguments[1],INT32_MAX,&pid) || !pid ||
     !string(env,arguments[2],job->ticket,sizeof(job->ticket)) ||
     !integer(env,arguments[3],5000,&job->timeout) || !job->timeout)
    { free(job); return invalid(env,"resource-receive-arguments"); }
  job->operation=RECEIVE; job->endpoint=endpoint; job->pid=(int)pid;
  endpoint->receiving=true; napi_create_reference(env,arguments[0],1,&job->owner);
  return queue(env,job);
}
static bool parse_frame(napi_env env,napi_value object,hvir_resource_frame *frame) {
  receipt_binding *receipt=unwrap(env,object,&receipt_tag);
  if(receipt) {
    if(receipt->released) return false;
    *frame=receipt->frame; return true;
  }
  hvir_resource_metadata *metadata=&frame->metadata;
  if(!number_property(env,object,"kind",2,&metadata->kind) || !metadata->kind ||
     !number_property(env,object,"width",8192,&metadata->width) || !metadata->width ||
     !number_property(env,object,"height",8192,&metadata->height) || !metadata->height ||
     !number_property(env,object,"fourcc",UINT32_MAX,&metadata->fourcc) ||
     !boolean_property(env,object,"premultiplied",&metadata->premultiplied) ||
     !number_property(env,object,"colorSpace",2,&metadata->color_space) || !metadata->color_space ||
     !number_property(env,object,"origin",2,&metadata->origin) || !metadata->origin ||
     !bigint(env,object,"modifier",&metadata->modifier) ||
     !number_property(env,object,"planeCount",4,&metadata->plane_count)) return false;
  if(metadata->kind==1) {
    napi_value surface; void *data=NULL; size_t size=0; bool buffer=false;
    if(metadata->plane_count || !property(env,object,"surface",&surface) ||
       napi_is_buffer(env,surface,&buffer)!=napi_ok || !buffer ||
       napi_get_buffer_info(env,surface,&data,&size)!=napi_ok || size!=sizeof(frame->surface)) return false;
    memcpy(&frame->surface,data,size); return frame->surface!=NULL;
  }
  napi_value planes; uint32_t count=0; bool array=false;
  if(!metadata->plane_count || !property(env,object,"planes",&planes) ||
     napi_is_array(env,planes,&array)!=napi_ok || !array ||
     napi_get_array_length(env,planes,&count)!=napi_ok || count!=metadata->plane_count) return false;
  for(uint32_t i=0;i<count;i++) {
    napi_value plane; uint32_t fd;
    if(napi_get_element(env,planes,i,&plane)!=napi_ok ||
       !number_property(env,plane,"fd",INT32_MAX,&fd) ||
       !number_property(env,plane,"stride",UINT32_MAX,&metadata->strides[i]) ||
       !number_property(env,plane,"offset",UINT32_MAX,&metadata->offsets[i]) ||
       !bigint(env,plane,"size",&metadata->sizes[i])) return false;
    frame->fds[i]=(int)fd;
  }
  return true;
}
static napi_value send_frame(napi_env env,napi_callback_info info) {
  size_t count=4; napi_value arguments[4]; napi_get_cb_info(env,info,&count,arguments,NULL,NULL);
  resource_job *job=calloc(1,sizeof(*job)); if(!job) return invalid(env,"resource-allocation-failed");
  job->operation=SEND; job->timeout=5000;
  uint32_t pid; hvir_resource_frame source={0};
  if(count!=4 || !string(env,arguments[0],job->address,sizeof(job->address)) ||
     !integer(env,arguments[1],INT32_MAX,&pid) || !pid ||
     !string(env,arguments[2],job->ticket,sizeof(job->ticket)) ||
     !parse_frame(env,arguments[3],&source))
    { free(job); return invalid(env,"resource-send-arguments"); }
  job->pid=(int)pid;
  if(!hvir_resource_snapshot(&source,&job->frame,&job->error)) {
    const char *error=job->error; free(job); return invalid(env,error);
  }
  return queue(env,job);
}
static napi_value release_receipt(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value arguments[1]; napi_get_cb_info(env,info,&count,arguments,NULL,NULL);
  receipt_binding *receipt=count==1?unwrap(env,arguments[0],&receipt_tag):NULL;
  if(!receipt) return invalid(env,"resource-receipt-invalid");
  if(!receipt->released) { receipt->released=true; hvir_resource_release(&receipt->frame); }
  napi_value undefined; napi_get_undefined(env,&undefined); return undefined;
}
static napi_value close_endpoint(napi_env env,napi_callback_info info) {
  size_t count=1; napi_value arguments[1]; napi_get_cb_info(env,info,&count,arguments,NULL,NULL);
  endpoint_binding *endpoint=count==1?unwrap(env,arguments[0],&endpoint_tag):NULL;
  if(!endpoint) return invalid(env,"resource-endpoint-invalid");
  if(endpoint->close_deferred) {
    napi_value pending; napi_get_reference_value(env,endpoint->close_promise,&pending); return pending;
  }
  napi_value promise; napi_deferred deferred;
  napi_create_promise(env,&deferred,&promise);
  if(endpoint->closed && !endpoint->native) {
    napi_value undefined; napi_get_undefined(env,&undefined); napi_resolve_deferred(env,deferred,undefined);
    return promise;
  }
  endpoint->closed=true; endpoint->close_deferred=deferred;
  napi_create_reference(env,arguments[0],1,&endpoint->close_owner);
  napi_create_reference(env,promise,1,&endpoint->close_promise);
  hvir_resource_endpoint_revoke(endpoint->native);
  if(!endpoint->receiving) settle_close(env,endpoint);
  return promise;
}
static napi_value initialize(napi_env env,napi_value exports) {
  const napi_property_descriptor properties[]={
    {"createEndpoint",NULL,create_endpoint,NULL,NULL,NULL,napi_default,NULL},
    {"receive",NULL,receive_frame,NULL,NULL,NULL,napi_default,NULL},
    {"sendFrame",NULL,send_frame,NULL,NULL,NULL,napi_default,NULL},
    {"release",NULL,release_receipt,NULL,NULL,NULL,napi_default,NULL},
    {"closeEndpoint",NULL,close_endpoint,NULL,NULL,NULL,napi_default,NULL}};
  napi_define_properties(env,exports,sizeof(properties)/sizeof(properties[0]),properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
