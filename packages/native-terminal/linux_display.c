#define _POSIX_C_SOURCE 200809L
#include "linux_display.h"
#include <stdlib.h>
#include <string.h>
#ifdef __linux__
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <dlfcn.h>

struct hvir_linux_display {
  void *library;
  EGLDisplay display;
  PFNEGLTERMINATEPROC terminate;
  PFNEGLGETPROCADDRESSPROC get_proc;
  bool query_device;
};
static bool extension(const char *list, const char *name) {
  if (!list || !name || !*name) return false;
  const size_t size = strlen(name);
  const char *at = list;
  while ((at = strstr(at, name))) {
    if ((at == list || at[-1] == ' ') && (at[size] == 0 || at[size] == ' ')) return true;
    at += size;
  }
  return false;
}
static bool render_node(const char *node) {
  static const char prefix[] = "/dev/dri/renderD";
  if (!node || strncmp(node, prefix, sizeof(prefix) - 1)) return false;
  size_t n = sizeof(prefix) - 1;
  if (!node[n]) return false;
  for (; n < 255 && node[n]; n++) if (node[n] < '0' || node[n] > '9') return false;
  return n < 255;
}
#define CORE(field, name) do { *(void **)(&(field)) = dlsym(owner->library, name); if (!(field)) goto unavailable; } while (0)
#define PROC(field, name) do { (field) = (__typeof__(field))get_proc(name); if (!(field)) goto unavailable; } while (0)
hvir_terminal_result hvir_linux_display_open(const char *node,
                                            hvir_linux_display **out, void **display) {
  if (!out || !display) return HVIR_INVALID;
  *out = NULL; *display = NULL;
  if (node && !render_node(node)) return HVIR_INVALID;
  hvir_linux_display *owner = calloc(1, sizeof(*owner));
  if (!owner) return HVIR_NOMEM;
  owner->display = EGL_NO_DISPLAY;
  owner->library = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
  if (!owner->library) goto unavailable;
  PFNEGLGETPROCADDRESSPROC get_proc;
  PFNEGLQUERYSTRINGPROC query_string;
  PFNEGLINITIALIZEPROC initialize;
  CORE(get_proc, "eglGetProcAddress"); CORE(query_string, "eglQueryString");
  CORE(initialize, "eglInitialize"); CORE(owner->terminate, "eglTerminate");
  owner->get_proc = get_proc;
  const char *client_extensions = query_string(EGL_NO_DISPLAY, EGL_EXTENSIONS);
  owner->query_device = extension(client_extensions, "EGL_EXT_device_base") ||
                        extension(client_extensions, "EGL_EXT_device_query");
  if (!node) { *out = owner; return HVIR_OK; }
  if ((!extension(client_extensions, "EGL_EXT_device_base") &&
       !(extension(client_extensions, "EGL_EXT_device_enumeration") &&
         extension(client_extensions, "EGL_EXT_device_query"))) ||
      !extension(client_extensions, "EGL_EXT_platform_device")) goto unavailable;
  PFNEGLQUERYDEVICESEXTPROC query_devices;
  PFNEGLQUERYDEVICESTRINGEXTPROC query_device;
  PFNEGLGETPLATFORMDISPLAYEXTPROC platform_display = NULL;
  PFNEGLGETPLATFORMDISPLAYPROC platform_core = NULL;
  PROC(query_devices, "eglQueryDevicesEXT"); PROC(query_device, "eglQueryDeviceStringEXT");
  *(void **)(&platform_core) = dlsym(owner->library, "eglGetPlatformDisplay");
  if (extension(client_extensions, "EGL_EXT_platform_base"))
    platform_display = (PFNEGLGETPLATFORMDISPLAYEXTPROC)get_proc("eglGetPlatformDisplayEXT");
  if (!platform_core && !platform_display) goto unavailable;
  EGLDeviceEXT devices[32]; EGLint count = 0;
  if (!query_devices(32, devices, &count) || count < 0 || count > 32) goto unavailable;
  for (EGLint i = 0; i < count; i++) {
    if (!extension(query_device(devices[i], EGL_EXTENSIONS), "EGL_EXT_device_drm_render_node")) continue;
    const char *actual = query_device(devices[i], EGL_DRM_RENDER_NODE_FILE_EXT);
    if (!actual || strcmp(actual, node)) continue;
    if (platform_core) owner->display = platform_core(EGL_PLATFORM_DEVICE_EXT, devices[i], NULL);
    if (owner->display == EGL_NO_DISPLAY && platform_display)
      owner->display = platform_display(EGL_PLATFORM_DEVICE_EXT, devices[i], NULL);
    if (owner->display == EGL_NO_DISPLAY) goto unavailable;
    EGLint major, minor;
    if (!initialize(owner->display, &major, &minor)) {
      owner->display = EGL_NO_DISPLAY;
      goto unavailable;
    }
    *out = owner; *display = owner->display;
    return HVIR_OK;
  }
unavailable:
  hvir_linux_display_close(owner);
  return HVIR_PRESENTATION;
}
void hvir_linux_display_render_node(hvir_linux_display *owner, void *display,
                                     char out[HVIR_TERMINAL_INFO_MAX]) {
  out[0] = 0;
  if (!owner || !owner->query_device || !display) return;
  PFNEGLQUERYDISPLAYATTRIBEXTPROC query_display =
      (PFNEGLQUERYDISPLAYATTRIBEXTPROC)owner->get_proc("eglQueryDisplayAttribEXT");
  PFNEGLQUERYDEVICESTRINGEXTPROC query_device =
      (PFNEGLQUERYDEVICESTRINGEXTPROC)owner->get_proc("eglQueryDeviceStringEXT");
  EGLAttrib device = 0;
  if (!query_display || !query_device ||
      !query_display((EGLDisplay)display, EGL_DEVICE_EXT, &device) || !device) return;
  EGLDeviceEXT selected = (EGLDeviceEXT)(uintptr_t)device;
  if (!extension(query_device(selected, EGL_EXTENSIONS), "EGL_EXT_device_drm_render_node")) return;
  const char *node = query_device(selected, EGL_DRM_RENDER_NODE_FILE_EXT);
  if (!node) return;
  const size_t length = strnlen(node, HVIR_TERMINAL_INFO_MAX - 1);
  memcpy(out, node, length); out[length] = 0;
}
void hvir_linux_display_close(hvir_linux_display *owner) {
  if (!owner) return;
  if (owner->display != EGL_NO_DISPLAY && owner->terminate) owner->terminate(owner->display);
  if (owner->library) dlclose(owner->library);
  free(owner);
}
#else
struct hvir_linux_display { int unused; };
hvir_terminal_result hvir_linux_display_open(const char *node,
                                            hvir_linux_display **out, void **display) {
  if (!out || !display) return HVIR_INVALID;
  *out = NULL; *display = NULL;
  return node ? HVIR_PRESENTATION : HVIR_OK;
}
void hvir_linux_display_render_node(hvir_linux_display *owner, void *display,
                                     char out[HVIR_TERMINAL_INFO_MAX]) {
  (void)owner; (void)display; out[0] = 0;
}
void hvir_linux_display_close(hvir_linux_display *owner) { (void)owner; }
#endif
