#ifndef HVIR_NATIVE_TERMINAL_H
#define HVIR_NATIVE_TERMINAL_H
#include <stddef.h>
#include <stdint.h>
/* Blocking native operations belong to one designated caller thread, never a UI loop.
 * Callback queues have an independent lock. Encoded input and replies are raw bytes. */
typedef struct hvir_terminal_host hvir_terminal_host;
typedef uint64_t hvir_terminal_id;
typedef enum {
  HVIR_OK = 0,
  HVIR_INVALID,
  HVIR_WRONG_THREAD,
  HVIR_CLOSED,
  HVIR_FAILED,
  HVIR_BOUND,
  HVIR_BUSY,
  HVIR_NOMEM,
  HVIR_TIMEOUT,
  HVIR_PRESENTATION
} hvir_terminal_result;
#define HVIR_TERMINAL_FEED_MAX 65536u
#define HVIR_TERMINAL_REPLY_MAX 65536u
#define HVIR_TERMINAL_TEXT_MAX 1048576u
#define HVIR_TERMINAL_PIXEL_MAX 16777216u
typedef struct {
  uint32_t kind;
  size_t length;
  uint32_t truncated; /* latest-value payload exceeded the returned 4096-byte bound */
  uint8_t data[4096];
} hvir_terminal_event;
/* width/height are physical pixels; native metrics determine columns/rows. */
typedef struct {
  uint64_t serial;
  double backing_scale; /* actual native-applied isotropic scale, bounded 1..4 */
  uint32_t columns, rows, width, height;
  uint32_t cell_width, cell_height, content_width, content_height, padding_left, padding_top;
} hvir_terminal_geometry;
typedef struct {
  uint64_t applied_sequence, reply_sequence, frame_copies, geometry_failure_serial;
  size_t queued_reply_bytes;
  uint32_t failure, closing;
  uint32_t renderer_health;      /* upstream state: 0 healthy, 1 unhealthy; not frame proof */
  uint32_t presentation_failure; /* acquisition error; parser remains usable */
  hvir_terminal_geometry geometry;
} hvir_terminal_status;
typedef struct {
  uint64_t lease, stream_sequence, geometry_serial;
  uint32_t kind; /* 1 IOSurface, 2 DMA-BUF, 3 owned RGBA pixels */
  uint32_t width, height, fourcc, plane_count;
  uint32_t premultiplied, color_space, origin; /* colors:1 sRGB,2 P3; origins:1 top,2 bottom */
  uint64_t modifier;
  void *surface; /* process-local retained IOSurface; never serialize pointer bytes */
  int32_t fds[4];
  uint32_t strides[4], offsets[4];
  uint64_t sizes[4];
  const uint8_t *pixels;
  size_t pixel_bytes;
} hvir_terminal_frame;
/* NULL display selects upstream's surfaceless EGL default on Linux. Optional display
 * is process-local, borrowed, configured before any surface, and outlives the host. */
hvir_terminal_result hvir_terminal_open(const char *library, void *display,
                                        hvir_terminal_host **out);
/* Starts construction and initial geometry without waiting for its acknowledgement.
 * The caller owns the returned state immediately and polls inspect before PTY spawn. */
hvir_terminal_result hvir_terminal_create_begin(hvir_terminal_host *, uint32_t width,
                                                uint32_t height, hvir_terminal_id *out);
hvir_terminal_result hvir_terminal_create(hvir_terminal_host *, uint32_t width, uint32_t height,
                                          hvir_terminal_id *out);
hvir_terminal_result hvir_terminal_feed(hvir_terminal_host *, hvir_terminal_id, uint64_t sequence,
                                        const uint8_t *, size_t);
hvir_terminal_result hvir_terminal_drain(hvir_terminal_host *, hvir_terminal_id, uint8_t *,
                                         size_t capacity, size_t *written);
hvir_terminal_result hvir_terminal_next_event(hvir_terminal_host *, hvir_terminal_id,
                                              hvir_terminal_event *);
hvir_terminal_result hvir_terminal_read(hvir_terminal_host *, hvir_terminal_id, uint8_t *,
                                        size_t capacity, size_t *written);
hvir_terminal_result hvir_terminal_resize(hvir_terminal_host *, hvir_terminal_id, uint64_t serial,
                                          uint32_t width, uint32_t height);
/* The same Surface applies scale and physical size before its serial is acknowledged.
 * PRESENTATION leaves prior acknowledged geometry and parser state available. */
hvir_terminal_result hvir_terminal_resize_scaled(hvir_terminal_host *, hvir_terminal_id,
                                                 uint64_t serial, uint32_t width,
                                                 uint32_t height, double backing_scale);
hvir_terminal_result hvir_terminal_visibility(hvir_terminal_host *, hvir_terminal_id, uint32_t visible);
hvir_terminal_result hvir_terminal_inspect(hvir_terminal_host *, hvir_terminal_id,
                                           hvir_terminal_status *);
/* Encode a Unicode text/key event using current native modes. key is a Ghostty key
 * enum from the pinned header; modifiers/action stay at this private native edge. */
hvir_terminal_result hvir_terminal_key(hvir_terminal_host *, hvir_terminal_id, uint32_t key,
                                       uint32_t modifiers, uint32_t action, const char *text,
                                       uint8_t *, size_t capacity, size_t *written);
hvir_terminal_result hvir_terminal_take_frame(hvir_terminal_host *, hvir_terminal_id,
                                              hvir_terminal_frame *);
/* Explicit compatibility readback of one held completed IOSurface, on the designated
 * caller thread. Packed BGRA rows; preserves lease and source color/alpha/origin.
 * Never performed by ordinary frame acquisition or release. */
hvir_terminal_result hvir_terminal_copy_frame(hvir_terminal_host *, hvir_terminal_id,
                                              uint64_t lease, uint8_t *out, size_t capacity,
                                              size_t *written, uint32_t *stride);
/* PRESENTATION means the resource was released but rearming drawing failed.
 * Parser state remains usable; duplicate release remains harmless. */
hvir_terminal_result hvir_terminal_release_frame(hvir_terminal_host *, hvir_terminal_id,
                                                 uint64_t lease);
/* Destroy revokes admission immediately. BUSY retains state until its outstanding
 * resource is released; inspect/release/destroy remain valid during retirement. */
hvir_terminal_result hvir_terminal_destroy(hvir_terminal_host *, hvir_terminal_id);
/* Fails busy while a state/resource remains. Frees host/app, never dlcloses initialized Ghostty. */
hvir_terminal_result hvir_terminal_close(hvir_terminal_host *);
#endif
