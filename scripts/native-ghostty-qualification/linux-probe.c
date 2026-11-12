// Bounded Linux embedding-boundary probe, not an Electron/GPU presentation demo.
#include <dlfcn.h>
#include <stdio.h>
#include <stdbool.h>
#include <stddef.h>
#include "ghostty.h"

static void wakeup(void *userdata) { (void)userdata; }
static bool action(ghostty_app_t app, ghostty_target_s target, ghostty_action_s event) {
  (void)app; (void)target; (void)event; return false;
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

#define LOAD(name) __typeof__(&name) api_##name = (__typeof__(&name))dlsym(library, #name); \
  if (!api_##name) { fprintf(stderr, "Missing pinned ABI symbol: %s\n", #name); return 14; }

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "Usage: linux-probe /absolute/path/to/ghostty-internal.so\n"); return 64; }
  puts("Known source boundary: the pinned embedded API declares macOS/iOS only.");
  puts("This probe tests native build/load/init and that missing platform boundary.");
  puts("It has no EGL runtime facade, DMA-BUF transport, Electron import or GPU qualification.");
  fflush(stdout);
  // Keep the library mapped until process exit: this ABI has no global shutdown.
  void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 10; }
  LOAD(ghostty_init);
  LOAD(ghostty_config_new);
  LOAD(ghostty_config_finalize);
  LOAD(ghostty_config_free);
  LOAD(ghostty_app_new);
  LOAD(ghostty_app_free);
  LOAD(ghostty_surface_config_new);
  LOAD(ghostty_surface_new);
  LOAD(ghostty_surface_free);
  if (api_ghostty_init(0, NULL) != 0) {
    fprintf(stderr, "Native global initialization failed before the platform probe.\n");
    return 11;
  }
  ghostty_config_t config = api_ghostty_config_new();
  if (!config) { fprintf(stderr, "Native config allocation failed.\n"); return 12; }
  api_ghostty_config_finalize(config); // Never load the maintainer's personal config.
  ghostty_runtime_config_s runtime = { .wakeup_cb = wakeup, .action_cb = action,
    .read_clipboard_cb = read_clipboard, .confirm_read_clipboard_cb = confirm_clipboard,
    .write_clipboard_cb = write_clipboard, .close_surface_cb = close_surface };
  ghostty_app_t app = api_ghostty_app_new(&runtime, config);
  api_ghostty_config_free(config);
  if (!app) {
    fprintf(stderr, "Native app initialization failed; inspect runtime.log before inferring a cause.\n");
    return 13;
  }
  puts("Native app initialization succeeded; no exported frame has been produced.");
  ghostty_surface_config_s options = api_ghostty_surface_config_new();
  // 3 is deliberately NOT a supported Linux tag. This is a known API limit,
  // tested explicitly after init, not a failed DMA-BUF or driver experiment.
  options.platform_tag = 3;
  ghostty_surface_t surface = api_ghostty_surface_new(app, &options);
  if (surface) {
    api_ghostty_surface_free(surface);
    api_ghostty_app_free(app);
    fprintf(stderr, "Unexpected acceptance of an undeclared platform tag; inspect the pinned source.\n");
    return 5;
  }
  api_ghostty_app_free(app);
  puts("Confirmed: no supported Linux embedding platform in this pinned facade. GPU path remains unqualified.");
  return 3;
}
