// Disposable two-surface macOS qualification bridge. Never loaded by hvir.
// Uses C APIs, including Objective-C runtime messaging, rather than a new source language.
#include <node_api.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <IOSurface/IOSurface.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include "ghostty.h"

extern id MTLCreateSystemDefaultDevice(void);
extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *);
extern void hvir_qualification_set_present(void (*)(void *, void *, uint32_t, uint32_t));
extern void hvir_qualification_set_write(void (*)(void *, const char *, size_t));
extern void hvir_qualification_set_context(ghostty_surface_t, void *);
extern void hvir_qualification_resize(ghostty_surface_t, uint32_t, uint32_t, uint64_t);
extern void hvir_qualification_set_resize(void (*)(void *, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t));
extern void hvir_qualification_feed(ghostty_surface_t, const char *, size_t);

// A slot is writable only before publication or after Electron releases every reference.
typedef struct {
  IOSurfaceRef surface;
  id texture;
  uint32_t width, height;
  uint64_t serial;
  int state; // 0 free, 1 copying, 2 pending, 3 owned by Electron
} Slot;
typedef struct {
  Slot slots[3];
  pthread_mutex_t lock;
  id device, queue, view;
  ghostty_app_t app;
  ghostty_surface_t terminal;
  bool running;
  uint64_t produced, dropped, copy_ns, max_copy_ns, copy_errors;
  char output[65536];
  size_t output_length;
  bool output_overflow;
  uint64_t resize_requested, resize_applied;
  uint32_t applied_cols, applied_rows, applied_width, applied_height;
} Session;
// Two fixed slots make the disposable ownership bound explicit. JS objects are never
// rebound to another session; callbacks keep stable userdata until surface_free joins.
static Session sessions[2];
static unsigned session_count;
static bool ghostty_initialized;
static Session *session(napi_env env, napi_callback_info info) {
  napi_value self; void *data = NULL;
  napi_get_cb_info(env, info, NULL, NULL, &self, NULL);
  if (napi_unwrap(env, self, &data) != napi_ok) {
    napi_throw_error(env, NULL, "Expected the original session object as receiver");
    return NULL;
  }
  return data;
}
static void write_output(void *context, const char *data, size_t length) {
  Session *s = context; if (!s) return;
  pthread_mutex_lock(&s->lock);
  if (length > sizeof(s->output) - s->output_length) s->output_overflow = true;
  else { memcpy(s->output + s->output_length, data, length); s->output_length += length; }
  pthread_mutex_unlock(&s->lock);
}
static void resize_applied(void *context, uint64_t serial, uint32_t cols,
    uint32_t rows, uint32_t width, uint32_t height) {
  Session *s = context; if (!s) return;
  pthread_mutex_lock(&s->lock);
  s->resize_applied = serial; s->applied_cols = cols; s->applied_rows = rows;
  s->applied_width = width; s->applied_height = height;
  pthread_mutex_unlock(&s->lock);
}
static uint64_t now_ns(void) {
  struct timespec time; clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000000000 + time.tv_nsec;
}

#define SEL(name) sel_registerName(name)
#define MSG0(type, receiver, name) ((type (*)(id, SEL))objc_msgSend)(receiver, SEL(name))
#define MSG1(type, receiver, name, atype, arg) \
  ((type (*)(id, SEL, atype))objc_msgSend)(receiver, SEL(name), arg)

static void number(CFMutableDictionaryRef dict, CFStringRef key, int64_t value) {
  CFNumberRef n = CFNumberCreate(NULL, kCFNumberSInt64Type, &value);
  CFDictionarySetValue(dict, key, n);
  CFRelease(n);
}

static id texture(Session *s, IOSurfaceRef surface, uint32_t width, uint32_t height) {
  id desc = MSG0(id, (id)objc_getClass("MTLTextureDescriptor"), "new");
  MSG1(void, desc, "setWidth:", unsigned long, width);
  MSG1(void, desc, "setHeight:", unsigned long, height);
  MSG1(void, desc, "setPixelFormat:", unsigned long, 80); // BGRA8Unorm
  MSG1(void, desc, "setUsage:", unsigned long, 5); // shaderRead | renderTarget
  MSG1(void, desc, "setStorageMode:", unsigned long, 0); // shared, Apple Silicon
  id result = ((id (*)(id, SEL, id, IOSurfaceRef, unsigned long))objc_msgSend)(
    s->device, SEL("newTextureWithDescriptor:iosurface:plane:"), desc, surface, 0);
  MSG0(void, desc, "release");
  return result;
}

static void clear_slot(Slot *slot) {
  if (slot->texture) MSG0(void, slot->texture, "release");
  if (slot->surface) CFRelease(slot->surface);
  // Preserve the reserved state while allocating outside the mutex. A second
  // completion callback must never observe this slot as free in the meantime.
  slot->surface = NULL; slot->texture = NULL;
  slot->width = 0; slot->height = 0;
}

// Runs on Ghostty's Metal completion thread, not the JS event loop.
// The synchronous GPU blit finishes before Ghostty can recycle its source texture.
static void present(void *context, void *source, uint32_t width, uint32_t height) {
  Session *s = context; if (!s) return;
  pthread_mutex_lock(&s->lock);
  if (!s->running) { pthread_mutex_unlock(&s->lock); return; }
  Slot *slot = NULL;
  for (int i = 0; i < 3; i++) if (s->slots[i].state == 0) { slot = &s->slots[i]; break; }
  if (!slot) { s->dropped++; pthread_mutex_unlock(&s->lock); return; }
  slot->state = 1;
  pthread_mutex_unlock(&s->lock);

  uint64_t copy_start = now_ns();
  void *pool = objc_autoreleasePoolPush();
  if (!slot->surface || !slot->texture || slot->width != width || slot->height != height) {
    clear_slot(slot);
    CFMutableDictionaryRef properties = CFDictionaryCreateMutable(NULL, 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    number(properties, kIOSurfaceWidth, width);
    number(properties, kIOSurfaceHeight, height);
    number(properties, kIOSurfaceBytesPerElement, 4);
    number(properties, kIOSurfacePixelFormat, 0x42475241); // BGRA
    slot->surface = IOSurfaceCreate(properties);
    CFRelease(properties);
    slot->width = width; slot->height = height;
    if (slot->surface) slot->texture = texture(s, slot->surface, width, height);
  }
  id input = texture(s, source, width, height);
  if (!slot->surface || !slot->texture || !input) {
    if (input) MSG0(void, input, "release");
    objc_autoreleasePoolPop(pool);
    pthread_mutex_lock(&s->lock); s->copy_errors++; slot->state = 0; pthread_mutex_unlock(&s->lock);
    return;
  }
  id buffer = MSG0(id, s->queue, "commandBuffer");
  id blit = MSG0(id, buffer, "blitCommandEncoder");
  typedef struct { unsigned long width, height, depth; } Size;
  typedef struct { unsigned long x, y, z; } Origin;
  ((void (*)(id, SEL, id, unsigned long, unsigned long, Origin, Size,
    id, unsigned long, unsigned long, Origin))objc_msgSend)(blit,
      SEL("copyFromTexture:sourceSlice:sourceLevel:sourceOrigin:sourceSize:toTexture:destinationSlice:destinationLevel:destinationOrigin:"),
      input, 0, 0, (Origin){0, 0, 0}, (Size){width, height, 1},
      slot->texture, 0, 0, (Origin){0, 0, 0});
  MSG0(void, blit, "endEncoding");
  MSG0(void, buffer, "commit");
  MSG0(void, buffer, "waitUntilCompleted");
  bool success = MSG0(unsigned long, buffer, "status") == 4;
  MSG0(void, input, "release");

  objc_autoreleasePoolPop(pool);
  pthread_mutex_lock(&s->lock);
  // Latest completed frame wins. Never replace one held by Chromium.
  for (int i = 0; i < 3; i++) if (s->slots[i].state == 2) s->slots[i].state = 0;
  uint64_t duration = now_ns() - copy_start;
  s->copy_ns += duration;
  if (duration > s->max_copy_ns) s->max_copy_ns = duration;
  slot->serial = ++s->produced;
  if (!success) s->copy_errors++;
  slot->state = s->running && success ? 2 : 0;
  pthread_mutex_unlock(&s->lock);
}

static void wakeup(void *unused) { (void)unused; }
static bool action(ghostty_app_t a, ghostty_target_s t, ghostty_action_s x) {
  (void)a; (void)t; (void)x; return false;
}
static ghostty_clipboard_read_result_e read_clipboard(void *u, ghostty_clipboard_e c,
  void *s, const char *const *m, size_t n, bool z) {
  (void)u; (void)c; (void)s; (void)m; (void)n; (void)z;
  return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE;
}
static void confirm_clipboard(void *u, const ghostty_clipboard_confirm_s *c,
  void *s, ghostty_clipboard_request_e r) { (void)u; (void)c; (void)s; (void)r; }
static void write_clipboard(void *u, ghostty_clipboard_e c,
  const ghostty_clipboard_content_s *d, size_t n, bool z) {
  (void)u; (void)c; (void)d; (void)n; (void)z;
}
static void close_surface(void *u, bool alive) { (void)u; (void)alive; }

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message); return NULL;
}
static napi_value undefined_value(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
static void field(napi_env env, napi_value object, const char *name, double n) {
  napi_value v; napi_create_double(env, n, &v); napi_set_named_property(env, object, name, v);
}
static void dispose_session(Session *s) {
  pthread_mutex_lock(&s->lock); s->running = false; pthread_mutex_unlock(&s->lock);
  if (s->terminal) { ghostty_surface_free(s->terminal); s->terminal = NULL; }
  if (s->app) { ghostty_app_free(s->app); s->app = NULL; }
  for (int i = 0; i < 3; i++) clear_slot(&s->slots[i]);
  if (s->view) { MSG0(void, s->view, "release"); s->view = NULL; }
  if (s->queue) { MSG0(void, s->queue, "release"); s->queue = NULL; }
  if (s->device) { MSG0(void, s->device, "release"); s->device = NULL; }
}
static napi_value startup_failure(napi_env env, Session *s, const char *message) {
  dispose_session(s); return fail(env, message);
}
static napi_value start(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (s->app) return fail(env, "Session already started");
  if (!ghostty_initialized) {
    if (ghostty_init(0, NULL) != 0) return fail(env, "ghostty_init failed");
    ghostty_initialized = true;
    hvir_qualification_set_present(present);
    hvir_qualification_set_write(write_output);
    hvir_qualification_set_resize(resize_applied);
  }
  ghostty_config_t config = ghostty_config_new();
  if (argc == 1) {
    char path[4096]; size_t length;
    if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &length) != napi_ok || length >= sizeof(path) - 1) {
      ghostty_config_free(config); return fail(env, "Expected an explicit experiment config path");
    }
    ghostty_config_load_file(config, path);
  }
  ghostty_config_finalize(config); // No personal configuration loaded.
  if (ghostty_config_diagnostics_count(config) != 0) {
    ghostty_config_free(config);
    return fail(env, "Experiment configuration has diagnostics; refusing silent fallback");
  }
  ghostty_runtime_config_s runtime = { .wakeup_cb = wakeup, .action_cb = action,
    .read_clipboard_cb = read_clipboard, .confirm_read_clipboard_cb = confirm_clipboard,
    .write_clipboard_cb = write_clipboard, .close_surface_cb = close_surface };
  s->app = ghostty_app_new(&runtime, config);
  ghostty_config_free(config);
  if (!s->app) return fail(env, "ghostty_app_new failed");
  s->device = MTLCreateSystemDefaultDevice();
  if (!s->device) return startup_failure(env, s, "Metal device unavailable");
  s->queue = MSG0(id, s->device, "newCommandQueue");
  if (!s->queue) return startup_failure(env, s, "Metal queue unavailable");
  s->view = MSG0(id, (id)objc_getClass("NSView"), "alloc");
  s->view = MSG1(id, s->view, "initWithFrame:", CGRect, CGRectMake(0, 0, 960, 600));
  if (!s->view) return startup_failure(env, s, "NSView unavailable");
  s->running = true;
  ghostty_surface_config_s options = ghostty_surface_config_new();
  options.userdata = s;
  options.platform_tag = GHOSTTY_PLATFORM_MACOS;
  options.platform.macos.nsview = s->view;
  options.scale_factor = 2;
  options.command = "/bin/sleep 86400"; // Disposable idle exec backend, not external PTY support.
  options.working_directory = "/tmp";
  s->terminal = ghostty_surface_new(s->app, &options);
  if (!s->terminal) return startup_failure(env, s, "ghostty_surface_new failed");
  hvir_qualification_set_context(s->terminal, s);
  ghostty_surface_set_size(s->terminal, 1920, 1200);
  ghostty_surface_set_focus(s->terminal, true);
  ghostty_surface_refresh(s->terminal);
  return undefined_value(env);
}
static napi_value tick(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  (void)info; if (s->app) ghostty_app_tick(s->app); return undefined_value(env);
}
static napi_value feed(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 1, length; napi_value args[1];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  void *bytes;
  if (!s->terminal || count != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length > 1024 * 1024)
    return fail(env, "feed requires a Buffer and a live surface");
  uint64_t started = now_ns();
  hvir_qualification_feed(s->terminal, bytes, length);
  napi_value result; napi_create_double(env, (now_ns() - started) / 1e6, &result);
  return result;
}
static napi_value take(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  (void)info; napi_value object; napi_create_object(env, &object);
  pthread_mutex_lock(&s->lock);
  field(env, object, "copyErrors", s->copy_errors);
  field(env, object, "copyMeanMs", s->produced ? s->copy_ns / (double)s->produced / 1e6 : 0);
  field(env, object, "copyMaxMs", s->max_copy_ns / 1e6);
  field(env, object, "produced", s->produced); field(env, object, "dropped", s->dropped);
  for (int i = 0; i < 3; i++) if (s->slots[i].state == 2) {
    Slot *slot = &s->slots[i]; slot->state = 3;
    napi_value pointer; napi_create_buffer_copy(env, sizeof(slot->surface), &slot->surface, NULL, &pointer);
    napi_set_named_property(env, object, "ioSurface", pointer);
    field(env, object, "slot", i); field(env, object, "serial", slot->serial);
    field(env, object, "width", slot->width); field(env, object, "height", slot->height);
    break;
  }
  pthread_mutex_unlock(&s->lock);
  return object;
}
static napi_value release(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 2; napi_value args[2]; double index, serial;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || napi_get_value_double(env, args[0], &index) != napi_ok ||
    napi_get_value_double(env, args[1], &serial) != napi_ok || index < 0 || index >= 3 || index != (int)index)
    return fail(env, "release requires an exact slot and serial");
  pthread_mutex_lock(&s->lock);
  Slot *slot = &s->slots[(int)index];
  if (slot->serial == serial && slot->state == 3) slot->state = 0;
  pthread_mutex_unlock(&s->lock);
  return undefined_value(env);
}
static napi_value stop(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  (void)info;
  pthread_mutex_lock(&s->lock);
  for (int i = 0; i < 3; i++) if (s->slots[i].state == 3) {
    pthread_mutex_unlock(&s->lock);
    return fail(env, "Electron still owns a texture; release it before stop");
  }
  pthread_mutex_unlock(&s->lock);
  dispose_session(s);
  return undefined_value(env);
}
static napi_value input(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 1, length; napi_value args[1]; void *bytes;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!s->terminal || count != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok)
    return fail(env, "input requires a Buffer and a live surface");
  ghostty_surface_text(s->terminal, bytes, length);
  return undefined_value(env);
}
static napi_value drain(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  (void)info; napi_value bytes;
  pthread_mutex_lock(&s->lock);
  if (s->output_overflow) { pthread_mutex_unlock(&s->lock); return fail(env, "Output probe overflowed"); }
  napi_create_buffer_copy(env, s->output_length, s->output, NULL, &bytes);
  s->output_length = 0;
  pthread_mutex_unlock(&s->lock);
  return bytes;
}
static napi_value resize(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 2; napi_value args[2]; uint32_t width, height;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!s->terminal || count != 2 || napi_get_value_uint32(env, args[0], &width) != napi_ok ||
      napi_get_value_uint32(env, args[1], &height) != napi_ok ||
      width < 100 || height < 100 || width > 4096 || height > 4096)
    return fail(env, "resize requires bounded dimensions and a live surface");
  MSG1(void, s->view, "setFrameSize:", CGSize, CGSizeMake(width / 2.0, height / 2.0));
  uint64_t serial = ++s->resize_requested;
  hvir_qualification_resize(s->terminal, width, height, serial);
  napi_value result; napi_create_double(env, (double)serial, &result); return result;
}
static napi_value applied_resize(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  napi_value result; napi_create_object(env, &result);
  pthread_mutex_lock(&s->lock);
  field(env, result, "ticket", s->resize_applied);
  field(env, result, "cols", s->applied_cols); field(env, result, "rows", s->applied_rows);
  field(env, result, "width", s->applied_width); field(env, result, "height", s->applied_height);
  field(env, result, "failed", s->resize_applied && (!s->applied_cols || !s->applied_rows));
  pthread_mutex_unlock(&s->lock); return result;
}
static napi_value size(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  (void)info;
  if (!s->terminal) return fail(env, "No surface");
  ghostty_surface_size_s size = ghostty_surface_size(s->terminal);
  napi_value result; napi_create_object(env, &result);
  field(env, result, "width", size.width_px); field(env, result, "height", size.height_px);
  field(env, result, "cellWidth", size.cell_width_px); field(env, result, "cellHeight", size.cell_height_px);
  field(env, result, "cols", size.columns); field(env, result, "rows", size.rows);
  return result;
}
// Bounded exact text readback for the disposable correctness workload, not a production API.
static napi_value snapshot(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t argc = 1; napi_value argv[1]; bool viewport = false;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!s->terminal) return fail(env, "No surface");
  if (argc) napi_get_value_bool(env, argv[0], &viewport);
  ghostty_point_tag_e tag = viewport ? GHOSTTY_POINT_VIEWPORT : GHOSTTY_POINT_SCREEN;
  ghostty_selection_s selection = {
    .top_left = { .tag = tag, .coord = GHOSTTY_POINT_COORD_TOP_LEFT },
    .bottom_right = { .tag = tag, .coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT },
  };
  ghostty_text_s text = {0};
  if (!ghostty_surface_read_text(s->terminal, selection, &text)) return fail(env, "Text readback failed");
  napi_value result;
  if (text.text_len > 2 * 1024 * 1024) {
    ghostty_surface_free_text(s->terminal, &text); return fail(env, "Text readback exceeds probe bound");
  }
  napi_create_string_utf8(env, text.text ? text.text : "", text.text_len, &result);
  ghostty_surface_free_text(s->terminal, &text);
  return result;
}
static napi_value scroll(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t argc = 2; napi_value argv[2]; double x, y;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!s->terminal || argc != 2 || napi_get_value_double(env, argv[0], &x) != napi_ok ||
      napi_get_value_double(env, argv[1], &y) != napi_ok || !isfinite(x) || !isfinite(y) ||
      fabs(x) > 100000 || fabs(y) > 100000) return fail(env, "Invalid pixel scroll");
  ghostty_surface_mouse_scroll(s->terminal, x, y, 1); // precision offsets in physical pixels
  return undefined_value(env);
}
static napi_value binding(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t argc = 1, length; napi_value argv[1]; char name[64];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (!s->terminal || argc != 1 || napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &length) != napi_ok || length >= sizeof(name) - 1)
    return fail(env, "Invalid binding");
  bool accepted = ghostty_surface_binding_action(s->terminal, name, length);
  napi_value result; napi_get_boolean(env, accepted, &result); return result;
}
// macOS virtual keycodes are supplied by the explicitly bounded experiment UI.
static napi_value key(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 3, length; napi_value args[3]; uint32_t code, mods;
  char text[64] = {0};
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!s->terminal || count != 3 ||
      napi_get_value_uint32(env, args[0], &code) != napi_ok || code > 127 ||
      napi_get_value_uint32(env, args[1], &mods) != napi_ok || mods > 15 ||
      napi_get_value_string_utf8(env, args[2], text, sizeof(text), &length) != napi_ok ||
      length >= sizeof(text) - 1) return fail(env, "Invalid experiment key");
  ghostty_input_key_s event = { .action = GHOSTTY_ACTION_PRESS,
    .mods = mods, .keycode = code, .text = text,
    .unshifted_codepoint = length == 1 ? (unsigned char)text[0] : 0 };
  ghostty_surface_key(s->terminal, event);
  return undefined_value(env);
}
static napi_value mouse(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 3; napi_value args[3]; double x, y; bool pressed;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!s->terminal || count != 3 ||
      napi_get_value_double(env, args[0], &x) != napi_ok ||
      napi_get_value_double(env, args[1], &y) != napi_ok ||
      napi_get_value_bool(env, args[2], &pressed) != napi_ok ||
      !isfinite(x) || !isfinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096)
    return fail(env, "Invalid experiment mouse");
  ghostty_surface_mouse_pos(s->terminal, x, y, GHOSTTY_MODS_NONE);
  ghostty_surface_mouse_button(s->terminal, pressed ? GHOSTTY_MOUSE_PRESS : GHOSTTY_MOUSE_RELEASE,
    GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE);
  return undefined_value(env);
}
static napi_value visible(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  size_t count = 1; napi_value args[1]; bool value;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!s->terminal || count != 1 || napi_get_value_bool(env, args[0], &value) != napi_ok)
    return fail(env, "Expected visibility and live surface");
  ghostty_surface_set_occlusion(s->terminal, value);
  if (value) ghostty_surface_refresh(s->terminal);
  return undefined_value(env);
}
static napi_value stats(napi_env env, napi_callback_info info) {
  Session *s = session(env, info); if (!s) return NULL;
  napi_value result; napi_create_object(env, &result);
  pthread_mutex_lock(&s->lock);
  int held = 0, pending = 0, copying = 0;
  for (int i = 0; i < 3; i++) {
    held += s->slots[i].state == 3; pending += s->slots[i].state == 2;
    copying += s->slots[i].state == 1;
  }
  field(env, result, "idlePid", s->terminal ? ghostty_surface_foreground_pid(s->terminal) : 0);
  field(env, result, "held", held); field(env, result, "pending", pending);
  field(env, result, "copying", copying); field(env, result, "slots", 3);
  field(env, result, "produced", s->produced); field(env, result, "dropped", s->dropped);
  field(env, result, "copyErrors", s->copy_errors);
  field(env, result, "outputBytes", s->output_length);
  field(env, result, "outputOverflow", s->output_overflow);
  pthread_mutex_unlock(&s->lock);
  return result;
}
static napi_value make_session(napi_env env, napi_value object) {
  if (session_count == 2) return fail(env, "Experiment supports exactly two session objects");
  Session *s = &sessions[session_count++];
  pthread_mutex_init(&s->lock, NULL);
  napi_wrap(env, object, s, NULL, NULL, NULL);
  napi_property_descriptor methods[] = {
    { "key", NULL, key, NULL, NULL, NULL, napi_default, NULL },
    { "mouse", NULL, mouse, NULL, NULL, NULL, napi_default, NULL },
    { "visible", NULL, visible, NULL, NULL, NULL, napi_default, NULL },
    { "stats", NULL, stats, NULL, NULL, NULL, napi_default, NULL },
    { "start", NULL, start, NULL, NULL, NULL, napi_default, NULL },
    { "tick", NULL, tick, NULL, NULL, NULL, napi_default, NULL },
    { "feed", NULL, feed, NULL, NULL, NULL, napi_default, NULL },
    { "take", NULL, take, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
    { "input", NULL, input, NULL, NULL, NULL, napi_default, NULL },
    { "drain", NULL, drain, NULL, NULL, NULL, napi_default, NULL },
    { "resize", NULL, resize, NULL, NULL, NULL, napi_default, NULL },
    { "appliedResize", NULL, applied_resize, NULL, NULL, NULL, napi_default, NULL },
    { "size", NULL, size, NULL, NULL, NULL, napi_default, NULL },
    { "snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL },
    { "scroll", NULL, scroll, NULL, NULL, NULL, napi_default, NULL },
    { "binding", NULL, binding, NULL, NULL, NULL, napi_default, NULL },
    { "stop", NULL, stop, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods);
  return object;
}

static napi_value create(napi_env env, napi_callback_info info) {
  (void)info; napi_value object; napi_create_object(env, &object);
  return make_session(env, object);
}
NAPI_MODULE_INIT() {
  make_session(env, exports);
  napi_property_descriptor method = { "create", NULL, create, NULL, NULL, NULL, napi_default, NULL };
  napi_define_properties(env, exports, 1, &method);
  return exports;
}
