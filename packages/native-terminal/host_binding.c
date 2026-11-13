#define _POSIX_C_SOURCE 200809L
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "terminal.h"

/* This module is loaded only by the utility's dedicated Node worker. It adds no
 * scheduler: the C facade's caller affinity remains authoritative. The wrapper
 * tracks only resources it owns, so environment finalization can settle them. */
typedef struct binding_state {
  struct binding_state *next;
  hvir_terminal_id id;
  uint64_t lease;
} binding_state;
typedef struct {
  hvir_terminal_host *native;
  binding_state *states;
} binding_host;
static const napi_type_tag host_tag = {0x12aec5d611d7465cULL, 0xa8075df1ea285ac9ULL};

typedef enum {
  OPEN,
  CREATE,
  FEED,
  RESIZE,
  INSPECT,
  READ,
  DRAIN,
  KEY,
  EVENT,
  TAKE_FRAME,
  RELEASE_FRAME,
  DESTROY,
  CLOSE,
  VISIBILITY,
  COPY_FRAME
} operation;
static bool checked(napi_env env, napi_status status) {
  if (status == napi_ok)
    return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending)
    napi_throw_error(env, NULL, "Native terminal binding operation failed");
  return false;
}
static void bad_argument(napi_env env) {
  napi_throw_type_error(env, NULL, "Invalid native terminal binding argument");
}
static napi_value number(napi_env env, uint32_t value) {
  napi_value result;
  return checked(env, napi_create_uint32(env, value, &result)) ? result : NULL;
}
static napi_value real(napi_env env, double value) {
  napi_value result;
  return checked(env, napi_create_double(env, value, &result)) ? result : NULL;
}
static napi_value integer(napi_env env, int32_t value) {
  napi_value result;
  return checked(env, napi_create_int32(env, value, &result)) ? result : NULL;
}
static napi_value big(napi_env env, uint64_t value) {
  napi_value result;
  return checked(env, napi_create_bigint_uint64(env, value, &result)) ? result : NULL;
}
static napi_value boolean(napi_env env, bool value) {
  napi_value result;
  return checked(env, napi_get_boolean(env, value, &result)) ? result : NULL;
}
static napi_value object(napi_env env) {
  napi_value result;
  return checked(env, napi_create_object(env, &result)) ? result : NULL;
}
static bool put(napi_env env, napi_value target, const char *name, napi_value value) {
  return target && value && checked(env, napi_set_named_property(env, target, name, value));
}
static napi_value outcome(napi_env env, hvir_terminal_result code) {
  napi_value result = object(env);
  return put(env, result, "result", number(env, code)) ? result : NULL;
}
static napi_value bytes(napi_env env, const void *data, size_t length) {
  napi_value result;
  return checked(env, napi_create_buffer_copy(env, length, data, NULL, &result)) ? result : NULL;
}
static bool u32(napi_env env, napi_value value, uint32_t *out) {
  napi_valuetype type;
  double numeric;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &numeric) != napi_ok ||
      !(numeric >= 0 && numeric <= UINT32_MAX) || (double)(uint32_t)numeric != numeric) {
    bad_argument(env);
    return false;
  }
  *out = (uint32_t)numeric;
  return true;
}
static bool u64(napi_env env, napi_value value, uint64_t *out) {
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, out, &lossless) != napi_ok || !lossless) {
    bad_argument(env);
    return false;
  }
  return true;
}
static char *text(napi_env env, napi_value value, size_t limit) {
  size_t length = 0, written = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > limit) {
    bad_argument(env);
    return NULL;
  }
  char *result = malloc(length + 1);
  if (!result) {
    napi_throw_error(env, NULL, "Native terminal binding allocation failed");
    return NULL;
  }
  if (!checked(env, napi_get_value_string_utf8(env, value, result, length + 1, &written)) ||
      written != length || memchr(result, 0, length)) {
    free(result);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending)
      bad_argument(env);
    return NULL;
  }
  return result;
}
static binding_host *host(napi_env env, napi_value value) {
  bool matches = false;
  binding_host *result = NULL;
  if (napi_check_object_type_tag(env, value, &host_tag, &matches) != napi_ok || !matches ||
      napi_unwrap(env, value, (void **)&result) != napi_ok || !result) {
    bad_argument(env);
    return NULL;
  }
  return result;
}
static binding_state **state_link(binding_host *h, hvir_terminal_id id) {
  binding_state **link = &h->states;
  while (*link && (*link)->id != id)
    link = &(*link)->next;
  return link;
}
static void finalize_host(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  binding_host *h = data;
  while (h->states) {
    binding_state *s = h->states;
    if (h->native) {
      hvir_terminal_result result = hvir_terminal_destroy(h->native, s->id);
      if (result == HVIR_BUSY && s->lease) {
        hvir_terminal_release_frame(h->native, s->id, s->lease);
        hvir_terminal_destroy(h->native, s->id);
      }
    }
    h->states = s->next;
    free(s);
  }
  if (h->native)
    hvir_terminal_close(h->native);
  free(h);
}
static napi_value geometry_value(napi_env env, const hvir_terminal_geometry *g) {
  napi_value result = object(env);
  if (!put(env, result, "serial", big(env, g->serial)) ||
      !put(env, result, "backingScale", real(env, g->backing_scale)))
    return NULL;
#define METRIC(name, member)                                                                       \
  if (!put(env, result, name, number(env, g->member)))                                             \
  return NULL
  METRIC("columns", columns);
  METRIC("rows", rows);
  METRIC("width", width);
  METRIC("height", height);
  METRIC("cellWidth", cell_width);
  METRIC("cellHeight", cell_height);
  METRIC("contentWidth", content_width);
  METRIC("contentHeight", content_height);
  METRIC("paddingLeft", padding_left);
  METRIC("paddingTop", padding_top);
#undef METRIC
  return result;
}
static napi_value status_value(napi_env env, const hvir_terminal_status *s) {
  napi_value result = object(env);
  if (!put(env, result, "appliedSequence", big(env, s->applied_sequence)) ||
      !put(env, result, "frameCopies", big(env, s->frame_copies)) ||
      !put(env, result, "geometryFailureSerial", big(env, s->geometry_failure_serial)) ||
      !put(env, result, "replySequence", big(env, s->reply_sequence)) ||
      !put(env, result, "queuedReplyBytes", number(env, (uint32_t)s->queued_reply_bytes)) ||
      !put(env, result, "failure", number(env, s->failure)) ||
      !put(env, result, "closing", boolean(env, s->closing != 0)) ||
      !put(env, result, "rendererHealth", number(env, s->renderer_health)) ||
      !put(env, result, "presentationFailure", number(env, s->presentation_failure)) ||
      !put(env, result, "geometry", geometry_value(env, &s->geometry)))
    return NULL;
  return result;
}
static napi_value frame_value(napi_env env, const hvir_terminal_frame *f) {
  if (f->plane_count > 4) {
    napi_throw_error(env, NULL, "Invalid native terminal frame metadata");
    return NULL;
  }
  napi_value result = object(env), planes;
  if (!checked(env, napi_create_array_with_length(env, f->plane_count, &planes)))
    return NULL;
#define FRAME_BIG(name, member)                                                                    \
  if (!put(env, result, name, big(env, f->member)))                                                \
  return NULL
#define FRAME_NUMBER(name, member)                                                                 \
  if (!put(env, result, name, number(env, f->member)))                                             \
  return NULL
  FRAME_BIG("lease", lease);
  FRAME_BIG("streamSequence", stream_sequence);
  FRAME_BIG("geometrySerial", geometry_serial);
  FRAME_BIG("modifier", modifier);
  FRAME_NUMBER("kind", kind);
  FRAME_NUMBER("width", width);
  FRAME_NUMBER("height", height);
  FRAME_NUMBER("fourcc", fourcc);
  FRAME_NUMBER("planeCount", plane_count);
  FRAME_NUMBER("colorSpace", color_space);
  FRAME_NUMBER("origin", origin);
#undef FRAME_BIG
#undef FRAME_NUMBER
  if (!put(env, result, "premultiplied", boolean(env, f->premultiplied != 0)))
    return NULL;
  for (uint32_t i = 0; i < f->plane_count; i++) {
    napi_value p = object(env);
    if (!put(env, p, "fd", integer(env, f->fds[i])) ||
        !put(env, p, "stride", number(env, f->strides[i])) ||
        !put(env, p, "offset", number(env, f->offsets[i])) ||
        !put(env, p, "size", big(env, f->sizes[i])) ||
        !checked(env, napi_set_element(env, planes, i, p)))
      return NULL;
  }
  if (!put(env, result, "planes", planes))
    return NULL;
  if (f->kind == 1 && !put(env, result, "surface", bytes(env, &f->surface, sizeof(f->surface))))
    return NULL;
  if (f->kind == 3 && !put(env, result, "pixels", bytes(env, f->pixels, f->pixel_bytes)))
    return NULL;
  return result;
}
static napi_value open_host(napi_env env, napi_value path) {
  char *library = text(env, path, 4096);
  if (!library)
    return NULL;
  binding_host *h = calloc(1, sizeof(*h));
  if (!h) {
    free(library);
    return outcome(env, HVIR_NOMEM);
  }
  hvir_terminal_result code = hvir_terminal_open(library, NULL, &h->native);
  free(library);
  if (code != HVIR_OK) {
    free(h);
    return outcome(env, code);
  }
  napi_value result = outcome(env, code), wrapper = object(env);
  if (!result || !wrapper || !checked(env, napi_type_tag_object(env, wrapper, &host_tag)) ||
      !checked(env, napi_wrap(env, wrapper, h, finalize_host, NULL, NULL))) {
    finalize_host(env, h, NULL);
    return NULL;
  }
  /* After wrapping, the JS object's finalizer owns cleanup even if property setup fails. */
  return put(env, result, "host", wrapper) ? result : NULL;
}
static napi_value read_bytes(napi_env env, binding_host *h, uint64_t id, uint32_t capacity,
                             operation op, uint32_t key, uint32_t mods, uint32_t action,
                             const char *input) {
  const uint32_t bound = op == READ ? HVIR_TERMINAL_TEXT_MAX : HVIR_TERMINAL_REPLY_MAX;
  if (capacity > bound)
    return outcome(env, HVIR_BOUND);
  uint8_t *data = malloc(capacity ? capacity : 1);
  if (!data)
    return outcome(env, HVIR_NOMEM);
  size_t written = 0;
  hvir_terminal_result code =
      op == READ ? hvir_terminal_read(h->native, id, data, capacity, &written)
      : op == DRAIN
          ? hvir_terminal_drain(h->native, id, data, capacity, &written)
          : hvir_terminal_key(h->native, id, key, mods, action, input, data, capacity, &written);
  napi_value result = outcome(env, code);
  if (code == HVIR_OK && result && !put(env, result, "data", bytes(env, data, written)))
    result = NULL;
  free(data);
  return result;
}
static napi_value invoke(napi_env env, napi_callback_info info) {
  static const size_t counts[] = {1, 3, 4, 5, 2, 3, 3, 7, 2, 2, 3, 2, 1, 3, 4};
  size_t argc = 8;
  napi_value args[8];
  void *data;
  if (!checked(env, napi_get_cb_info(env, info, &argc, args, NULL, &data)))
    return NULL;
  operation op = (operation)(uintptr_t)data;
  if (op == RESIZE ? (argc != 5 && argc != 6) : argc != counts[op]) {
    bad_argument(env);
    return NULL;
  }
  if (op == OPEN)
    return open_host(env, args[0]);
  binding_host *h = host(env, args[0]);
  if (!h)
    return NULL;
  if (!h->native)
    return outcome(env, HVIR_CLOSED);
  uint64_t id = 0, serial = 0;
  uint32_t width = 0, height = 0, capacity = 0;
  if (op != CREATE && op != CLOSE && !u64(env, args[1], &id))
    return NULL;
  if (op == CREATE) {
    if (!u32(env, args[1], &width) || !u32(env, args[2], &height))
      return NULL;
    binding_state *s = calloc(1, sizeof(*s));
    if (!s)
      return outcome(env, HVIR_NOMEM);
    hvir_terminal_result code = hvir_terminal_create_begin(h->native, width, height, &s->id);
    if (code != HVIR_OK) {
      free(s);
      return outcome(env, code);
    }
    s->next = h->states;
    h->states = s;
    napi_value result = outcome(env, code);
    return put(env, result, "id", big(env, s->id)) ? result : NULL;
  }
  if (op == CLOSE) {
    hvir_terminal_result code = hvir_terminal_close(h->native);
    if (code == HVIR_OK)
      h->native = NULL;
    return outcome(env, code);
  }
  if (op == FEED) {
    napi_typedarray_type type;
    size_t length, offset;
    void *input;
    napi_value buffer;
    bool plain = false;
    if (!u64(env, args[2], &serial))
      return NULL;
    if (napi_get_typedarray_info(env, args[3], &type, &length, &input, &buffer, &offset) !=
            napi_ok ||
        type != napi_uint8_array || napi_is_arraybuffer(env, buffer, &plain) != napi_ok || !plain) {
      bad_argument(env);
      return NULL;
    }
    if (length > HVIR_TERMINAL_FEED_MAX)
      return outcome(env, HVIR_BOUND);
    uint8_t *copy = malloc(length ? length : 1);
    if (!copy)
      return outcome(env, HVIR_NOMEM);
    if (length)
      memcpy(copy, input, length);
    hvir_terminal_result code = hvir_terminal_feed(h->native, id, serial, copy, length);
    free(copy);
    return outcome(env, code);
  }
  if (op == RESIZE) {
    if (!u64(env, args[2], &serial) || !u32(env, args[3], &width) || !u32(env, args[4], &height))
      return NULL;
    double scale = 1;
    if (argc == 6 && napi_get_value_double(env, args[5], &scale) != napi_ok) {
      bad_argument(env);
      return NULL;
    }
    return outcome(env, hvir_terminal_resize_scaled(h->native, id, serial, width, height, scale));
  }
  if (op == VISIBILITY) {
    bool visible;
    if (napi_get_value_bool(env, args[2], &visible) != napi_ok) {
      bad_argument(env);
      return NULL;
    }
    return outcome(env, hvir_terminal_visibility(h->native, id, visible ? 1 : 0));
  }
  if (op == COPY_FRAME) {
    if (!u64(env, args[2], &serial) || !u32(env, args[3], &capacity)) return NULL;
    if (!capacity || capacity > HVIR_TERMINAL_PIXEL_MAX) return outcome(env, HVIR_BOUND);
    uint8_t *data = malloc(capacity);
    if (!data) return outcome(env, HVIR_NOMEM);
    size_t written = 0;
    uint32_t stride = 0;
    hvir_terminal_result code = hvir_terminal_copy_frame(h->native, id, serial, data,
                                                        capacity, &written, &stride);
    napi_value result = outcome(env, code);
    if (code == HVIR_OK && (!put(env, result, "data", bytes(env, data, written)) ||
                            !put(env, result, "stride", number(env, stride)))) result = NULL;
    free(data);
    return result;
  }
  if (op == INSPECT) {
    hvir_terminal_status status;
    hvir_terminal_result code = hvir_terminal_inspect(h->native, id, &status);
    napi_value result = outcome(env, code);
    return code != HVIR_OK || put(env, result, "status", status_value(env, &status)) ? result
                                                                                     : NULL;
  }
  if (op == READ || op == DRAIN) {
    if (!u32(env, args[2], &capacity))
      return NULL;
    return read_bytes(env, h, id, capacity, op, 0, 0, 0, NULL);
  }
  if (op == KEY) {
    uint32_t key, mods, action;
    if (!u32(env, args[2], &key) || !u32(env, args[3], &mods) || !u32(env, args[4], &action) ||
        !u32(env, args[6], &capacity))
      return NULL;
    char *input = text(env, args[5], HVIR_TERMINAL_FEED_MAX);
    if (!input)
      return NULL;
    napi_value result = read_bytes(env, h, id, capacity, KEY, key, mods, action, input);
    free(input);
    return result;
  }
  if (op == EVENT) {
    hvir_terminal_event event;
    hvir_terminal_result code = hvir_terminal_next_event(h->native, id, &event);
    napi_value result = outcome(env, code);
    if (code != HVIR_OK)
      return result;
    napi_value value = object(env);
    return put(env, value, "kind", number(env, event.kind)) &&
                   put(env, value, "truncated", boolean(env, event.truncated != 0)) &&
                   put(env, value, "data", bytes(env, event.data, event.length)) &&
                   put(env, result, "event", value)
               ? result
               : NULL;
  }
  if (op == TAKE_FRAME) {
    hvir_terminal_frame frame;
    hvir_terminal_result code = hvir_terminal_take_frame(h->native, id, &frame);
    napi_value result = outcome(env, code);
    if (code != HVIR_OK)
      return result;
    binding_state *s = *state_link(h, id);
    if (!s) {
      hvir_terminal_release_frame(h->native, id, frame.lease);
      return outcome(env, HVIR_INVALID);
    }
    s->lease = frame.lease;
    napi_value value = result ? frame_value(env, &frame) : NULL;
    if (!value || !put(env, result, "frame", value)) {
      hvir_terminal_release_frame(h->native, id, frame.lease);
      s->lease = 0;
      return NULL;
    }
    return result;
  }
  if (op == RELEASE_FRAME) {
    if (!u64(env, args[2], &serial))
      return NULL;
    hvir_terminal_result code = hvir_terminal_release_frame(h->native, id, serial);
    binding_state *s = *state_link(h, id);
    if (s && s->lease == serial && (code == HVIR_OK || code == HVIR_PRESENTATION))
      s->lease = 0;
    return outcome(env, code);
  }
  hvir_terminal_result code = hvir_terminal_destroy(h->native, id);
  if (code == HVIR_OK) {
    binding_state **link = state_link(h, id), *s = *link;
    if (s) {
      *link = s->next;
      free(s);
    }
  }
  return outcome(env, code);
}
static napi_value initialize(napi_env env, napi_value exports) {
  static const char *names[] = {"open",         "createBegin", "feed", "resize", "inspect",
                                "read",         "drain",       "key",  "event",  "takeFrame",
                                "releaseFrame", "destroy",     "close", "visibility", "copyFrame"};
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    napi_value function;
    if (!checked(env, napi_create_function(env, names[i], NAPI_AUTO_LENGTH, invoke,
                                           (void *)(uintptr_t)i, &function)) ||
        !put(env, exports, names[i], function))
      return NULL;
  }
  return exports;
}
NAPI_MODULE(hvir_native_terminal_host, initialize)
