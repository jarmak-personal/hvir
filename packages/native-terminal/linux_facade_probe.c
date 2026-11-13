#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Real Linux GL/thread/frame proof, never a hardware-DMA qualification. */
#ifdef __linux__
static unsigned checks;
static uint64_t now(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static void yield(void) { const struct timespec t = {.tv_nsec = 1000000}; nanosleep(&t, NULL); }
static bool check(bool value, const char *name) {
  checks++;
  if (!value) fprintf(stderr, "linux-facade-probe: %s\n", name);
  return value;
}
static bool frame(hvir_terminal_host *host, hvir_terminal_id id, uint32_t kind,
                  uint64_t serial, hvir_terminal_frame *out) {
  const uint64_t deadline = now() + 10000;
  do {
    hvir_terminal_status status;
    if (hvir_terminal_inspect(host, id, &status) != HVIR_OK || status.failure) return false;
    hvir_terminal_result result = hvir_terminal_take_frame(host, id, out);
    if (result == HVIR_OK) {
      if ((!kind || out->kind == kind) && out->geometry_serial == serial) return true;
      if (hvir_terminal_release_frame(host, id, out->lease) != HVIR_OK) return false;
    } else if (result != HVIR_BUSY && result != HVIR_PRESENTATION) return false;
    yield();
  } while (now() < deadline);
  return false;
}
static bool geometry(hvir_terminal_host *host, hvir_terminal_id id, uint64_t serial) {
  const uint64_t deadline = now() + 10000;
  do {
    hvir_terminal_status status;
    if (hvir_terminal_inspect(host, id, &status) != HVIR_OK || status.failure) return false;
    if (status.geometry.serial == serial) return true;
    yield();
  } while (now() < deadline);
  return false;
}
#define REQUIRE(value, name) do { if (!check((value), (name))) goto cleanup; } while (0)
static void *run(void *argument) {
  const char *library = argument;
  hvir_terminal_host *host = NULL;
  hvir_terminal_id id = 0;
  hvir_terminal_frame held = {0};
  uint8_t *copy = NULL;
  int passed = 0;
  hvir_terminal_renderer_info info;
  REQUIRE(hvir_terminal_open_linux(library, "/tmp/not-a-render-node", 0, &host) == HVIR_INVALID && !host,
          "invalid-device-refused-before-library-or-spawn");
  REQUIRE(hvir_terminal_open_linux(library, NULL, 1, &host) == HVIR_OK && host, "pixels-host-open");
  REQUIRE(hvir_terminal_create(host, 640, 384, &id) == HVIR_OK, "pixels-state-created");
  const char initial[] = "\x1b[?25l\x1b[41m\x1b[2Jsame-parser";
  REQUIRE(hvir_terminal_feed(host, id, 1, (const uint8_t *)initial, sizeof(initial) - 1) == HVIR_OK,
          "pixels-parser-feed");
  REQUIRE(frame(host, id, 3, 1, &held), "initial-pixels-before-first-export");
  REQUIRE(hvir_terminal_renderer_info_get(host, id, &info) == HVIR_OK && info.available &&
          info.gl_vendor[0] && info.gl_renderer[0] && info.gl_version[0] && info.egl_vendor[0] &&
          info.pixel_frames > 0 && !info.dma_buf_frames, "actual-context-attribution-and-initial-mode");
  const size_t bytes = (size_t)held.width * held.height * 4;
  copy = malloc(bytes);
  REQUIRE(copy && bytes <= HVIR_TERMINAL_PIXEL_MAX, "bounded-copy-storage");
  size_t written; uint32_t stride;
  REQUIRE(hvir_terminal_copy_frame(host, id, held.lease, copy, bytes - 1, &written, &stride) == HVIR_BOUND,
          "copy-refuses-insufficient-capacity");
  REQUIRE(hvir_terminal_copy_frame(host, id, held.lease, copy, bytes, &written, &stride) == HVIR_OK &&
          written == bytes && stride == held.width * 4, "owned-kind3-copy");
  REQUIRE(held.pixels && copy[0] == held.pixels[2] && copy[2] == held.pixels[0] &&
          copy[1] == held.pixels[1] && copy[3] == held.pixels[3], "rgba-source-to-private-bgra");
  REQUIRE(hvir_terminal_presentation_mode(host, id, 0) == HVIR_OK, "auto-request-on-held-same-state");
  REQUIRE(hvir_terminal_release_frame(host, id, held.lease) == HVIR_OK, "release-for-auto"); held.lease = 0;
  REQUIRE(frame(host, id, 0, 1, &held), "auto-produces-actual-resource-kind");
  const uint32_t auto_kind = held.kind;
  REQUIRE(auto_kind == 2 || auto_kind == 3, "auto-gpu-or-explicit-pixels");
  REQUIRE(hvir_terminal_presentation_mode(host, id, 1) == HVIR_OK, "pixels-request-on-held-same-state");
  REQUIRE(hvir_terminal_release_frame(host, id, held.lease) == HVIR_OK, "release-for-pixels"); held.lease = 0;
  REQUIRE(frame(host, id, 3, 1, &held), "mode-request-is-not-ack-until-kind3");
  REQUIRE(hvir_terminal_resize(host, id, 2, 2050, 2048) == HVIR_OK && geometry(host, id, 2),
          "oversize-applied-while-old-lease-held");
  REQUIRE(hvir_terminal_release_frame(host, id, held.lease) == HVIR_OK, "release-before-bound-observation"); held.lease = 0;
  const uint64_t deadline = now() + 10000;
  hvir_terminal_status status = {0};
  do { REQUIRE(hvir_terminal_inspect(host, id, &status) == HVIR_OK, "inspect-native-bound");
    if (status.renderer_health == 1) break;
    yield();
  } while (now() < deadline);
  REQUIRE(status.renderer_health == 1 && !status.failure, "preallocation-bound-is-visible-not-parser-failure");
  const uint64_t bound_deadline = now() + 10000;
  hvir_terminal_result bounded_frame;
  do {
    bounded_frame = hvir_terminal_take_frame(host, id, &held);
    if (bounded_frame != HVIR_BUSY) break;
    yield();
  } while (now() < bound_deadline);
  REQUIRE(bounded_frame == HVIR_PRESENTATION, "bound-is-not-endless-busy");
  const char marker[] = "\r\nparser-survives-bound";
  REQUIRE(hvir_terminal_feed(host, id, 2, (const uint8_t *)marker, sizeof(marker) - 1) == HVIR_OK,
          "parser-live-after-native-bound");
  uint8_t retained[4096]; size_t retained_size = 0;
  REQUIRE(hvir_terminal_read(host, id, retained, sizeof(retained) - 1, &retained_size) == HVIR_OK,
          "parser-read-after-native-bound");
  retained[retained_size] = 0;
  REQUIRE(strstr((char *)retained, "parser-survives-bound") != NULL, "same-parser-retains-bound-tail");
  REQUIRE(hvir_terminal_resize(host, id, 3, 640, 384) == HVIR_OK && geometry(host, id, 3), "recovery-geometry");
  REQUIRE(frame(host, id, 3, 3, &held), "actual-successful-pixels-recovers-health");
  const uint64_t health_deadline = now() + 10000;
  do {
    REQUIRE(hvir_terminal_inspect(host, id, &status) == HVIR_OK && !status.failure,
            "inspect-native-recovery");
    if (status.renderer_health == 0) break;
    yield();
  } while (now() < health_deadline);
  REQUIRE(status.renderer_health == 0, "recovered-renderer-not-mode-flag");
  REQUIRE(hvir_terminal_release_frame(host, id, held.lease) == HVIR_OK, "release-final"); held.lease = 0;
  REQUIRE(hvir_terminal_destroy(host, id) == HVIR_OK, "state-close"); id = 0;
  REQUIRE(hvir_terminal_close(host) == HVIR_OK, "host-close"); host = NULL;
  printf("{\"linuxFacade\":\"passed\",\"checks\":%u,\"initialPixels\":true,\"autoFrameKind\":%u,"
         "\"sameParserModeTransition\":true,\"nativePreallocationBound\":true,\"nativeHealthRecovery\":true,"
         "\"hardwareGpuQualified\":false}\n", checks, auto_kind);
  passed = 1;
cleanup:
  free(copy);
  if (host && id) { if (held.lease) hvir_terminal_release_frame(host, id, held.lease); hvir_terminal_destroy(host, id); }
  if (host) hvir_terminal_close(host);
  return (void *)(uintptr_t)(passed ? 0 : 1);
}
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pthread_t worker; void *result;
  if (pthread_create(&worker, NULL, run, argv[1]) || pthread_join(worker, &result)) return 1;
  return (int)(uintptr_t)result;
}
#else
int main(void) { return 77; }
#endif
