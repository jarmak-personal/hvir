// Disposable single-surface macOS qualification bridge. Never loaded by hvir.
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
#include "ghostty.h"

extern id MTLCreateSystemDefaultDevice(void);
extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *);
extern void hvir_qualification_set_present(void (*)(void *, uint32_t, uint32_t));
extern void hvir_qualification_set_write(void (*)(const char *, size_t));
extern void hvir_qualification_feed(ghostty_surface_t, const char *, size_t);

// A slot is writable only before publication or after Electron releases every reference.
typedef struct {
  IOSurfaceRef surface;
  id texture;
  uint32_t width, height;
  uint64_t serial;
  int state; // 0 free, 1 copying, 2 pending, 3 owned by Electron
} Slot;
static Slot slots[3];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static id device, queue, view;
static ghostty_app_t app;
static ghostty_surface_t terminal;
static bool running;
static uint64_t produced, dropped, copy_ns, max_copy_ns, copy_errors;
static char output[65536];
static size_t output_length;
static bool output_overflow;
static void write_output(const char *data, size_t length) {
  pthread_mutex_lock(&lock);
  if (length > sizeof(output) - output_length) output_overflow = true;
  else { memcpy(output + output_length, data, length); output_length += length; }
  pthread_mutex_unlock(&lock);
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

static id texture(IOSurfaceRef surface, uint32_t width, uint32_t height) {
  id desc = MSG0(id, (id)objc_getClass("MTLTextureDescriptor"), "new");
  MSG1(void, desc, "setWidth:", unsigned long, width);
  MSG1(void, desc, "setHeight:", unsigned long, height);
  MSG1(void, desc, "setPixelFormat:", unsigned long, 80); // BGRA8Unorm
  MSG1(void, desc, "setUsage:", unsigned long, 5); // shaderRead | renderTarget
  MSG1(void, desc, "setStorageMode:", unsigned long, 0); // shared, Apple Silicon
  id result = ((id (*)(id, SEL, id, IOSurfaceRef, unsigned long))objc_msgSend)(
    device, SEL("newTextureWithDescriptor:iosurface:plane:"), desc, surface, 0);
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
static void present(void *source, uint32_t width, uint32_t height) {
  pthread_mutex_lock(&lock);
  if (!running) { pthread_mutex_unlock(&lock); return; }
  Slot *slot = NULL;
  for (int i = 0; i < 3; i++) if (slots[i].state == 0) { slot = &slots[i]; break; }
  if (!slot) { dropped++; pthread_mutex_unlock(&lock); return; }
  slot->state = 1;
  pthread_mutex_unlock(&lock);

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
    if (slot->surface) slot->texture = texture(slot->surface, width, height);
  }
  id input = texture(source, width, height);
  if (!slot->surface || !slot->texture || !input) {
    if (input) MSG0(void, input, "release");
    objc_autoreleasePoolPop(pool);
    pthread_mutex_lock(&lock); copy_errors++; slot->state = 0; pthread_mutex_unlock(&lock);
    return;
  }
  id buffer = MSG0(id, queue, "commandBuffer");
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
  pthread_mutex_lock(&lock);
  // Latest completed frame wins. Never replace one held by Chromium.
  for (int i = 0; i < 3; i++) if (slots[i].state == 2) slots[i].state = 0;
  uint64_t duration = now_ns() - copy_start;
  copy_ns += duration;
  if (duration > max_copy_ns) max_copy_ns = duration;
  slot->serial = ++produced;
  if (!success) copy_errors++;
  slot->state = running && success ? 2 : 0;
  pthread_mutex_unlock(&lock);
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
static napi_value start(napi_env env, napi_callback_info info) {
  (void)info;
  if (app) return fail(env, "Only one disposable surface is supported");
  if (ghostty_init(0, NULL) != 0) return fail(env, "ghostty_init failed");
  ghostty_config_t config = ghostty_config_new();
  ghostty_config_finalize(config); // No personal configuration loaded.
  ghostty_runtime_config_s runtime = { .wakeup_cb = wakeup, .action_cb = action,
    .read_clipboard_cb = read_clipboard, .confirm_read_clipboard_cb = confirm_clipboard,
    .write_clipboard_cb = write_clipboard, .close_surface_cb = close_surface };
  app = ghostty_app_new(&runtime, config);
  ghostty_config_free(config);
  if (!app) return fail(env, "ghostty_app_new failed");
  device = MTLCreateSystemDefaultDevice();
  if (!device) return fail(env, "Metal device unavailable");
  queue = MSG0(id, device, "newCommandQueue");
  if (!queue) return fail(env, "Metal queue unavailable");
  view = MSG0(id, (id)objc_getClass("NSView"), "alloc");
  view = MSG1(id, view, "initWithFrame:", CGRect, CGRectMake(0, 0, 960, 600));
  running = true;
  hvir_qualification_set_present(present);
  hvir_qualification_set_write(write_output);
  ghostty_surface_config_s options = ghostty_surface_config_new();
  options.platform_tag = GHOSTTY_PLATFORM_MACOS;
  options.platform.macos.nsview = view;
  options.scale_factor = 2;
  options.command = "/bin/sleep 120"; // Disposable idle exec backend, not external PTY support.
  options.working_directory = "/tmp";
  terminal = ghostty_surface_new(app, &options);
  if (!terminal) return fail(env, "ghostty_surface_new failed");
  ghostty_surface_set_size(terminal, 1920, 1200);
  ghostty_surface_set_focus(terminal, true);
  ghostty_surface_refresh(terminal);
  return undefined_value(env);
}
static napi_value tick(napi_env env, napi_callback_info info) {
  (void)info; if (app) ghostty_app_tick(app); return undefined_value(env);
}
static napi_value feed(napi_env env, napi_callback_info info) {
  size_t count = 1, length; napi_value args[1];
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  void *bytes;
  if (!terminal || count != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok)
    return fail(env, "feed requires a Buffer and a live surface");
  hvir_qualification_feed(terminal, bytes, length);
  return undefined_value(env);
}
static napi_value take(napi_env env, napi_callback_info info) {
  (void)info; napi_value object; napi_create_object(env, &object);
  pthread_mutex_lock(&lock);
  field(env, object, "copyErrors", copy_errors);
  field(env, object, "copyMeanMs", produced ? copy_ns / (double)produced / 1e6 : 0);
  field(env, object, "copyMaxMs", max_copy_ns / 1e6);
  field(env, object, "produced", produced); field(env, object, "dropped", dropped);
  for (int i = 0; i < 3; i++) if (slots[i].state == 2) {
    Slot *slot = &slots[i]; slot->state = 3;
    napi_value pointer; napi_create_buffer_copy(env, sizeof(slot->surface), &slot->surface, NULL, &pointer);
    napi_set_named_property(env, object, "ioSurface", pointer);
    field(env, object, "slot", i); field(env, object, "serial", slot->serial);
    field(env, object, "width", slot->width); field(env, object, "height", slot->height);
    break;
  }
  pthread_mutex_unlock(&lock);
  return object;
}
static napi_value release(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; double index, serial;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || napi_get_value_double(env, args[0], &index) != napi_ok ||
    napi_get_value_double(env, args[1], &serial) != napi_ok || index < 0 || index >= 3 || index != (int)index)
    return fail(env, "release requires an exact slot and serial");
  pthread_mutex_lock(&lock);
  Slot *slot = &slots[(int)index];
  if (slot->serial == serial && slot->state == 3) slot->state = 0;
  pthread_mutex_unlock(&lock);
  return undefined_value(env);
}
static napi_value stop(napi_env env, napi_callback_info info) {
  (void)info;
  pthread_mutex_lock(&lock); running = false; pthread_mutex_unlock(&lock);
  if (terminal) { ghostty_surface_free(terminal); terminal = NULL; }
  if (app) { ghostty_app_free(app); app = NULL; }
  hvir_qualification_set_present(NULL);
  hvir_qualification_set_write(NULL);
  // Caller must first close the receiving window and wait for allReferencesReleased.
  for (int i = 0; i < 3; i++) {
    if (slots[i].state == 3) return fail(env, "Electron still owns a texture; release it before stop");
    clear_slot(&slots[i]);
  }
  if (view) { MSG0(void, view, "release"); view = NULL; }
  if (queue) { MSG0(void, queue, "release"); queue = NULL; }
  if (device) { MSG0(void, device, "release"); device = NULL; }
  return undefined_value(env);
}
static napi_value input(napi_env env, napi_callback_info info) {
  size_t count = 1, length; napi_value args[1]; void *bytes;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!terminal || count != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok)
    return fail(env, "input requires a Buffer and a live surface");
  ghostty_surface_text(terminal, bytes, length);
  return undefined_value(env);
}
static napi_value drain(napi_env env, napi_callback_info info) {
  (void)info; napi_value bytes;
  pthread_mutex_lock(&lock);
  if (output_overflow) { pthread_mutex_unlock(&lock); return fail(env, "Output probe overflowed"); }
  napi_create_buffer_copy(env, output_length, output, NULL, &bytes);
  output_length = 0;
  pthread_mutex_unlock(&lock);
  return bytes;
}
static napi_value resize(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; uint32_t width, height;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (!terminal || count != 2 || napi_get_value_uint32(env, args[0], &width) != napi_ok ||
      napi_get_value_uint32(env, args[1], &height) != napi_ok ||
      width < 100 || height < 100 || width > 4096 || height > 4096)
    return fail(env, "resize requires bounded dimensions and a live surface");
  MSG1(void, view, "setFrameSize:", CGSize, CGSizeMake(width / 2.0, height / 2.0));
  ghostty_surface_set_size(terminal, width, height);
  return undefined_value(env);
}
static napi_value size(napi_env env, napi_callback_info info) {
  (void)info;
  if (!terminal) return fail(env, "No surface");
  ghostty_surface_size_s size = ghostty_surface_size(terminal);
  napi_value result; napi_create_object(env, &result);
  field(env, result, "cols", size.columns); field(env, result, "rows", size.rows);
  return result;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    { "start", NULL, start, NULL, NULL, NULL, napi_default, NULL },
    { "tick", NULL, tick, NULL, NULL, NULL, napi_default, NULL },
    { "feed", NULL, feed, NULL, NULL, NULL, napi_default, NULL },
    { "take", NULL, take, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
    { "input", NULL, input, NULL, NULL, NULL, napi_default, NULL },
    { "drain", NULL, drain, NULL, NULL, NULL, napi_default, NULL },
    { "resize", NULL, resize, NULL, NULL, NULL, napi_default, NULL },
    { "size", NULL, size, NULL, NULL, NULL, napi_default, NULL },
    { "stop", NULL, stop, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
