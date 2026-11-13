#ifndef HVIR_RESOURCE_EDGE_H
#define HVIR_RESOURCE_EDGE_H
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#define HVIR_RESOURCE_ADDRESS_MAX 128
#define HVIR_RESOURCE_TICKET_MAX 128
/* Only process-local references occur here. The wire protocol never carries these
 * pointer/fd values: Mach descriptors or SCM_RIGHTS create receiver-owned rights. */
typedef struct {
  uint32_t kind, width, height, fourcc, premultiplied, color_space, origin, plane_count;
  uint64_t modifier;
  uint32_t strides[4], offsets[4];
  uint64_t sizes[4];
} hvir_resource_metadata;
typedef struct {
  hvir_resource_metadata metadata;
  void *surface;
  int fds[4];
} hvir_resource_frame;
typedef struct hvir_resource_endpoint hvir_resource_endpoint;
/* All blocking methods run only in Node-API async workers. Errors are fixed,
 * content-free labels. snapshot/release perform only bounded reference work. */
bool hvir_resource_snapshot(const hvir_resource_frame *, hvir_resource_frame *, const char **);
void hvir_resource_release(hvir_resource_frame *);
bool hvir_resource_endpoint_create(const char *, hvir_resource_endpoint **, const char **);
void hvir_resource_endpoint_revoke(hvir_resource_endpoint *);
void hvir_resource_endpoint_free(hvir_resource_endpoint *);
bool hvir_resource_receive(hvir_resource_endpoint *, int, const char *, uint32_t,
                           hvir_resource_frame *, const char **);
bool hvir_resource_send(const char *, int, const char *, uint32_t,
                        const hvir_resource_frame *, const char **);
#endif
