#define _POSIX_C_SOURCE 200809L
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include "linux_display.h"

/* Exercise the real Linux owner through its immediate dynamic EGL dependency.
 * No driver/context/window is created, and no production test hook is added. */
static int library_token, display_token, devices[2];
static const char *extensions, *missing;
static bool no_library, no_alloc, core, ext, core_fail, ext_fail, init_fail;
static bool enum_fail, no_node_extension, no_node, query_fail;
static int count, opens, closes, initializations, terminations, core_calls, ext_calls;
static int allocations;
static unsigned checks;
static void *probe_calloc(size_t n, size_t size) {
  if (no_alloc) return NULL;
  void *p = calloc(n, size); if (p) allocations++; return p;
}
static void probe_free(void *p) { if (p) allocations--; free(p); }
static const char *EGLAPIENTRY query_string(EGLDisplay display, EGLint name) {
  return display == EGL_NO_DISPLAY && name == EGL_EXTENSIONS ? extensions : NULL;
}
static EGLBoolean EGLAPIENTRY initialize(EGLDisplay display, EGLint *major, EGLint *minor) {
  initializations++;
  if (display != &display_token || init_fail) return EGL_FALSE;
  *major = 1; *minor = 5; return EGL_TRUE;
}
static EGLBoolean EGLAPIENTRY terminate(EGLDisplay display) {
  if (display != &display_token) abort();
  terminations++; return EGL_TRUE;
}
static EGLBoolean EGLAPIENTRY query_devices(EGLint capacity, EGLDeviceEXT *out, EGLint *written) {
  if (capacity != 32) abort();
  *written = count;
  if (enum_fail) return EGL_FALSE;
  if (count >= 0 && count <= 32)
    for (int i = 0; i < count; i++) out[i] = &devices[i % 2];
  return EGL_TRUE;
}
static const char *EGLAPIENTRY query_device(EGLDeviceEXT device, EGLint name) {
  if (name == EGL_EXTENSIONS)
    return no_node_extension ? "EGL_EXT_device_drm_render_node_suffix" : "EGL_EXT_device_drm_render_node";
  if (name != EGL_DRM_RENDER_NODE_FILE_EXT || no_node) return NULL;
  return device == &devices[1] ? "/dev/dri/renderD129" : "/dev/dri/renderD128";
}
static EGLDisplay EGLAPIENTRY platform_core(EGLenum platform, void *device, const EGLAttrib *attrs) {
  if (platform != EGL_PLATFORM_DEVICE_EXT || device != &devices[1] || attrs) abort();
  core_calls++; return core_fail ? EGL_NO_DISPLAY : &display_token;
}
static EGLDisplay EGLAPIENTRY platform_ext(EGLenum platform, void *device, const EGLint *attrs) {
  if (platform != EGL_PLATFORM_DEVICE_EXT || device != &devices[1] || attrs) abort();
  ext_calls++; return ext_fail ? EGL_NO_DISPLAY : &display_token;
}
static EGLBoolean EGLAPIENTRY query_display(EGLDisplay display, EGLint name, EGLAttrib *out) {
  if (display != &display_token || name != EGL_DEVICE_EXT || query_fail) return EGL_FALSE;
  *out = (EGLAttrib)(uintptr_t)&devices[1]; return EGL_TRUE;
}
static __eglMustCastToProperFunctionPointerType EGLAPIENTRY get_proc(const char *name) {
  if (missing && !strcmp(name, missing)) return NULL;
#define PROC(name_, fn) if (!strcmp(name, name_)) return (__eglMustCastToProperFunctionPointerType)(fn)
  PROC("eglQueryDevicesEXT", query_devices);
  PROC("eglQueryDeviceStringEXT", query_device);
  PROC("eglQueryDisplayAttribEXT", query_display);
  if (ext) { PROC("eglGetPlatformDisplayEXT", platform_ext); }
#undef PROC
  return NULL;
}
static void *probe_dlopen(const char *name, int flags) {
  if (strcmp(name, "libEGL.so.1") || flags != (RTLD_NOW | RTLD_LOCAL)) abort();
  opens++; return no_library ? NULL : &library_token;
}
static void *probe_dlsym(void *library, const char *name) {
  if (library != &library_token) abort();
  if (missing && !strcmp(name, missing)) return NULL;
#define SYMBOL(name_, type, fn) if (!strcmp(name, name_)) { union { type function; void *pointer; } value = {.function = fn}; return value.pointer; }
  SYMBOL("eglGetProcAddress", PFNEGLGETPROCADDRESSPROC, get_proc);
  SYMBOL("eglQueryString", PFNEGLQUERYSTRINGPROC, query_string);
  SYMBOL("eglInitialize", PFNEGLINITIALIZEPROC, initialize);
  SYMBOL("eglTerminate", PFNEGLTERMINATEPROC, terminate);
  if (core) { SYMBOL("eglGetPlatformDisplay", PFNEGLGETPLATFORMDISPLAYPROC, platform_core); }
#undef SYMBOL
  return NULL;
}
static int probe_dlclose(void *library) {
  if (library != &library_token) abort();
  closes++; return 0;
}
#define dlopen probe_dlopen
#define dlsym probe_dlsym
#define dlclose probe_dlclose
#define calloc probe_calloc
#define free probe_free
/* Scratch macOS compilation uses official Khronos headers and this Linux branch;
 * the maintained Linux build does not define any platform override. */
#if !defined(__linux__)
#define __linux__ 1
#define HVIR_PROBE_RESTORE_PLATFORM
#endif
#include "linux_display.c"
#ifdef HVIR_PROBE_RESTORE_PLATFORM
#undef __linux__
#endif
#undef dlopen
#undef dlsym
#undef dlclose
#undef calloc
#undef free

static void reset(void) {
  if (allocations) abort();
  extensions = "EGL_EXT_device_base EGL_EXT_platform_device EGL_EXT_platform_base";
  missing = NULL; no_library = no_alloc = false; core = ext = true;
  core_fail = ext_fail = init_fail = enum_fail = no_node_extension = no_node = query_fail = false;
  count = 2; opens = closes = initializations = terminations = core_calls = ext_calls = 0;
}
static bool check(bool okay, const char *contract) {
  checks++; if (!okay) fprintf(stderr, "linux-display-probe: %s\n", contract); return okay;
}
#define REQUIRE(value, contract) do { if (!check((value), contract)) return 1; } while (0)
static bool refuses(void) {
  hvir_linux_display *owner = (void *)(uintptr_t)1; void *display = (void *)(uintptr_t)1;
  const bool okay = hvir_linux_display_open("/dev/dri/renderD129", &owner, &display) == HVIR_PRESENTATION &&
    !owner && !display && !allocations && opens == 1 && closes == !no_library && !terminations;
  return okay;
}
int main(void) {
  hvir_linux_display *owner = NULL; void *display = NULL; char node[HVIR_TERMINAL_INFO_MAX];
  reset();
  REQUIRE(hvir_linux_display_open(NULL, &owner, &display) == HVIR_OK && owner && !display &&
    !initializations && !terminations && allocations == 1, "default-keeps-borrowed-null-display");
  hvir_linux_display_render_node(owner, &display_token, node);
  REQUIRE(!strcmp(node, "/dev/dri/renderD129"), "default-reports-measured-device-not-selector");
  hvir_linux_display_close(owner); owner = NULL;
  REQUIRE(!allocations && closes == 1 && !terminations, "default-closes-only-owned-library");
  reset();
  REQUIRE(hvir_linux_display_open("/dev/dri/renderD129", &owner, &display) == HVIR_OK &&
    display == &display_token && initializations == 1 && core_calls == 1 && !ext_calls,
    "explicit-node-uses-core-egl15-display");
  hvir_linux_display_render_node(owner, display, node);
  REQUIRE(!strcmp(node, "/dev/dri/renderD129"), "explicit-node-is-confirmed-by-display-query");
  missing = "eglQueryDisplayAttribEXT";
  hvir_linux_display_render_node(owner, display, node);
  REQUIRE(!node[0], "missing-diagnostic-query-remains-unknown");
  hvir_linux_display_close(owner); owner = NULL;
  REQUIRE(terminations == 1 && closes == 1 && !allocations, "owned-initialized-display-terminates-once");
  hvir_linux_display_close(NULL);
  REQUIRE(terminations == 1 && closes == 1, "null-close-is-idempotent");
  reset(); core = false;
  REQUIRE(hvir_linux_display_open("/dev/dri/renderD129", &owner, &display) == HVIR_OK &&
    ext_calls == 1 && !core_calls, "ext-platform-fallback");
  hvir_linux_display_close(owner); owner = NULL;
  reset(); core_fail = true;
  REQUIRE(hvir_linux_display_open("/dev/dri/renderD129", &owner, &display) == HVIR_OK &&
    core_calls == 1 && ext_calls == 1, "core-rejection-tries-supported-ext-route");
  hvir_linux_display_close(owner); owner = NULL;
  reset(); extensions = "EGL_EXT_device_enumeration EGL_EXT_device_query EGL_EXT_platform_device";
  REQUIRE(hvir_linux_display_open("/dev/dri/renderD129", &owner, &display) == HVIR_OK,
    "enumeration-plus-query-equivalent-to-device-base");
  hvir_linux_display_close(owner); owner = NULL;
  reset(); core = false; extensions = "EGL_EXT_device_base EGL_EXT_platform_device";
  REQUIRE(refuses(), "ext-platform-call-requires-extension-advertisement");
  reset(); extensions = "EGL_EXT_device_base_suffix EGL_EXT_platform_device EGL_EXT_platform_base";
  REQUIRE(refuses(), "extension-token-match-is-exact");
  reset(); extensions = NULL;
  REQUIRE(refuses(), "missing-client-extensions-refuses-selection");
  const char *required[] = {"eglGetProcAddress", "eglQueryString", "eglInitialize", "eglTerminate",
    "eglQueryDevicesEXT", "eglQueryDeviceStringEXT"};
  for (unsigned i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
    reset(); missing = required[i]; REQUIRE(refuses(), "missing-required-symbol-cleans-partial-owner");
  }
  reset(); core = ext = false;
  REQUIRE(refuses(), "missing-platform-entrypoints-refuses");
  reset(); no_node_extension = true;
  REQUIRE(refuses(), "render-node-extension-must-match-exactly");
  reset(); no_node = true;
  REQUIRE(refuses(), "missing-device-node-never-selects-a-different-gpu");
  reset(); count = 1;
  REQUIRE(refuses(), "requested-device-absent-never-falls-back");
  reset(); count = 33;
  REQUIRE(refuses(), "enumeration-is-bounded");
  reset(); enum_fail = true;
  REQUIRE(refuses(), "enumeration-failure-cleans-owner");
  reset(); core_fail = ext_fail = true;
  REQUIRE(refuses(), "platform-display-failure-cleans-owner");
  reset(); init_fail = true;
  REQUIRE(refuses() && initializations == 1, "failed-initialization-never-owns-initialized-display");
  reset(); no_library = true;
  REQUIRE(refuses(), "missing-egl-library-cleans-allocation");
  reset(); no_alloc = true;
  REQUIRE(hvir_linux_display_open(NULL, &owner, &display) == HVIR_NOMEM && !owner && !display &&
    !opens && !allocations, "allocation-failure-publishes-nothing");
  reset();
  REQUIRE(hvir_linux_display_open("/dev/dri/card0", &owner, &display) == HVIR_INVALID && !opens,
    "invalid-selector-never-opens-library");
  REQUIRE(hvir_linux_display_open("/dev/dri/renderD129x", &owner, &display) == HVIR_INVALID && !opens,
    "selector-rejects-trailing-data");
  printf("{\"linuxDisplayOwner\":\"passed\",\"checks\":%u,\"syntheticEglDependency\":true,\"hardwareGpuQualified\":false}\n", checks);
  return 0;
}
