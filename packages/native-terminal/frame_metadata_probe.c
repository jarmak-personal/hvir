#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <stdbool.h>
static bool fail_allocation;
static unsigned live_allocations;
static void *probe_malloc(size_t size) {
  if (fail_allocation) { fail_allocation = false; return NULL; }
  void *value = malloc(size);
  if (value) live_allocations++;
  return value;
}
static void *probe_calloc(size_t count, size_t size) {
  if (fail_allocation) { fail_allocation = false; return NULL; }
  void *value = calloc(count, size);
  if (value) live_allocations++;
  return value;
}
static void probe_free(void *value) {
  if (value) live_allocations--;
  free(value);
}
#define malloc probe_malloc
#define calloc probe_calloc
#define free probe_free
/* Immediate private adapter dependency: malformed native metadata must not close
 * producer descriptors or leak partially acquired consumer references. Including
 * the owner keeps its static callback private; no Ghostty initialization occurs. */
#include "terminal.c"
#undef malloc
#undef calloc
#undef free
#include <dirent.h>
#include <errno.h>
#include <stdio.h>

static unsigned checks;
static bool verify(bool passed, const char *contract) {
  checks++;
  if (!passed) fprintf(stderr, "frame-metadata-probe: contract failed: %s\n", contract);
  return passed;
}
#define REQUIRE(value, contract) do { if (!verify((value), (contract))) goto cleanup; } while (0)

static int descriptor_count(void) {
#ifdef __linux__
  DIR *directory = opendir("/proc/self/fd");
#else
  DIR *directory = opendir("/dev/fd");
#endif
  if (!directory) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)))
    if (entry->d_name[0] >= '0' && entry->d_name[0] <= '9') count++;
  closedir(directory);
  return count;
}

static bool rejected(terminal_state *state, hvir_ghostty_external_frame *frame,
                     int source, int descriptors) {
  state->failure = 0;
  state->presentation_failure = 0;
  return !frame_ready(state, frame) && !state->failure && state->presentation_failure &&
    !state->frame_available && !state->frame_taken && !state->frame.kind &&
    fcntl(source, F_GETFD) >= 0 && descriptor_count() == descriptors;
}

static bool accept_feed(ghostty_surface_t surface, const uint8_t *bytes, size_t length,
                        uint64_t sequence) {
  (void)surface;
  return sequence == 1 && length == 2 && memcmp(bytes, "ok", 2) == 0;
}
static bool return_text(ghostty_surface_t surface, uint8_t *out, size_t capacity, size_t *written) {
  (void)surface;
  if (capacity < 2) return false;
  memcpy(out, "ok", 2);
  *written = 2;
  return true;
}
static void idle_tick(ghostty_app_t app) { (void)app; }
static bool reject_rearm(ghostty_surface_t surface) { (void)surface; return false; }

static uint64_t pending_geometry;
static ghostty_surface_t begin_native_create(ghostty_app_t app, void *display,
    const hvir_ghostty_external_config *config, uint32_t width, uint32_t height) {
  (void)app; (void)display; (void)width; (void)height;
  return (ghostty_surface_t)config->userdata;
}
static bool pending_resize(ghostty_surface_t surface, uint32_t width, uint32_t height,
                            uint64_t serial, double scale) {
  (void)scale;
  (void)surface; (void)width; (void)height;
  pending_geometry = serial;
  return true;
}
static bool failed_resize(ghostty_surface_t surface, uint32_t width, uint32_t height,
                           uint64_t serial, double scale) {
  (void)surface; (void)width; (void)height; (void)serial; (void)scale;
  return false;
}
static void drop_surface(ghostty_surface_t surface) { (void)surface; }
static bool partial_frame_accepted;
static ghostty_surface_t reject_native_create(ghostty_app_t app, void *display,
    const hvir_ghostty_external_config *config, uint32_t width, uint32_t height) {
  (void)app; (void)display; (void)width; (void)height;
  const uint8_t pixel[4] = {1, 2, 3, 255};
  const hvir_ghostty_external_frame frame = {.kind = 3, .width = 1, .height = 1,
    .pixels = pixel, .pixel_bytes = sizeof(pixel)};
  partial_frame_accepted = config->frame(config->userdata, &frame);
  return NULL;
}

int main(void) {
#ifdef __APPLE__
  IOSurfaceRef copy_surface = NULL;
#endif
  int result = 1, pipes[2] = {-1, -1};
  FILE *source = NULL;
  hvir_terminal_host host = {0};
  terminal_state state = {.host = &host};
  if (pthread_mutex_init(&host.events, NULL)) return 70;
  if (pthread_cond_init(&host.changed, NULL)) {
    pthread_mutex_destroy(&host.events);
    return 70;
  }
  source = tmpfile();
  REQUIRE(source != NULL, "create-private-seekable-descriptor");
  const int fd = fileno(source);
  REQUIRE(ftruncate(fd, 4096) == 0, "size-private-frame-allocation");
  REQUIRE(pipe(pipes) == 0, "create-nonseekable-descriptors");
  const int baseline = descriptor_count();
  REQUIRE(baseline >= 0, "descriptor-count-observable");
  host.caller = pthread_self();
  host.next_id = 1;
  hvir_terminal_host *unpublished = &host;
  fail_allocation = true;
  REQUIRE(hvir_terminal_open("unused-not-loaded", NULL, &unpublished) == HVIR_NOMEM &&
          !unpublished && !live_allocations && descriptor_count() == baseline,
          "open-allocation-failure-publishes-no-host");
  hvir_terminal_id unpublished_id = 0;
  fail_allocation = true;
  REQUIRE(hvir_terminal_create(&host, 640, 480, &unpublished_id) == HVIR_NOMEM &&
          !unpublished_id && !host.states && !live_allocations &&
          descriptor_count() == baseline, "create-allocation-failure-publishes-no-state");
  host.external_new = reject_native_create;
  REQUIRE(hvir_terminal_create(&host, 640, 480, &unpublished_id) == HVIR_FAILED &&
          partial_frame_accepted && !unpublished_id && !host.states &&
          !live_allocations && descriptor_count() == baseline,
          "partial-native-create-releases-state-and-early-frame-copy");
  host.external_new = begin_native_create;
  host.external_resize = pending_resize;
  host.surface_free = drop_surface;
  host.app_tick = idle_tick;
  REQUIRE(hvir_terminal_create_begin(&host, 640, 480, &unpublished_id) == HVIR_OK &&
          unpublished_id && host.states && host.states->geometry.serial == 0 &&
          pending_geometry == 1 && live_allocations == 1,
          "create-begin-publishes-owned-state-without-waiting-for-geometry");
  hvir_terminal_status pending_status;
  hvir_terminal_frame initializing_frame;
  REQUIRE(hvir_terminal_inspect(&host, unpublished_id, &pending_status) == HVIR_OK &&
          pending_status.geometry.serial == 0 && !pending_status.failure &&
          pending_status.renderer_health == GHOSTTY_RENDERER_HEALTH_HEALTHY &&
          hvir_terminal_take_frame(&host, unpublished_id, &initializing_frame) == HVIR_BUSY,
          "pending-initial-geometry-is-busy-and-can-be-polled-without-blocking");
  applied(host.states, 1, 80, 24, 640, 480, 8, 16, 640, 384, 0, 0, 1);
  REQUIRE(hvir_terminal_inspect(&host, unpublished_id, &pending_status) == HVIR_OK &&
          pending_status.geometry.serial == 1 &&
          hvir_terminal_destroy(&host, unpublished_id) == HVIR_OK &&
          !host.states && !live_allocations && descriptor_count() == baseline,
          "create-begin-acknowledges-and-cleans-the-same-owned-state");
  state.id = 900;
  state.requested_geometry = 7;
  state.geometry.serial = 6;
  host.states = &state;
  REQUIRE(hvir_terminal_resize(&host, state.id, 8, 0, 480) == HVIR_BOUND &&
          state.requested_geometry == 7, "invalid-resize-preserves-requested-serial");
  state.surface = (ghostty_surface_t)&state;
  host.external_resize = failed_resize;
  REQUIRE(hvir_terminal_resize_scaled(&host, state.id, 8, 640, 480, 2) == HVIR_PRESENTATION &&
          state.geometry.serial == 6 && state.geometry_failure_serial == 8 && !state.failure,
          "failed-scale-is-correlated-without-false-geometry-ack-or-parser-poison");
  applied(&state, 8, 80, 24, 640, 480, 8, 16, 640, 384, 0, 0, 2);
  REQUIRE(state.geometry.serial == 6, "failed-scale-cannot-later-acknowledge-same-serial");
  host.external_resize = pending_resize;
  REQUIRE(hvir_terminal_resize_scaled(&host, state.id, 9, 640, 480, 1) == HVIR_OK,
          "later-scale-operation-can-recover");
  applied(&state, 9, 80, 24, 640, 480, 8, 16, 640, 384, 0, 0, 1);
  REQUIRE(state.geometry.serial == 9 && state.geometry.backing_scale == 1 &&
          !state.geometry_failure_serial, "only-later-applied-geometry-clears-scale-failure");
  REQUIRE(hvir_terminal_resize_scaled(&host, state.id, 10, 640, 480, NAN) == HVIR_BOUND &&
          hvir_terminal_resize_scaled(&host, state.id, 10, 640, 480, 0.5) == HVIR_BOUND &&
          hvir_terminal_resize_scaled(&host, state.id, 10, 640, 480, 4.1) == HVIR_BOUND &&
          state.requested_geometry == 9, "invalid-scale-preserves-requested-serial");
  state.requested_geometry = 7;
  state.geometry = (hvir_terminal_geometry){.serial = 6};
  state.closing = true;
  applied(&state, 7, 80, 24, 640, 480, 8, 16, 640, 384, 0, 0, 1);
  REQUIRE(state.geometry.serial == 6 && state.geometry.width == 0,
          "late-applied-callback-cannot-mutate-closing-state");
  state.closing = false;
  failed(&state, 17);
  REQUIRE(state.failure == 17, "native-geometry-failure-is-latched");
  applied(&state, 7, 80, 24, 640, 480, 8, 16, 640, 384, 0, 0, 1);
  REQUIRE(state.geometry.serial == 6 && state.geometry.width == 0 &&
          state.failure == 17, "late-applied-callback-cannot-advance-failed-state");
  state.failure = 0;
  host.external_frame_release = reject_rearm;
  host.app_tick = idle_tick;
  state.surface = (ghostty_surface_t)&state;
  state.frame_taken = true;
  state.frame_available = true;
  state.frame.lease = 33;
  REQUIRE(hvir_terminal_release_frame(&host, state.id, 33) == HVIR_PRESENTATION &&
          !state.frame_taken && !state.frame_available && !state.failure &&
          state.last_released == 33,
          "release-rearm-failure-is-explicit-without-parser-failure");
  REQUIRE(hvir_terminal_release_frame(&host, state.id, 33) == HVIR_OK && !state.failure,
          "release-rearm-failure-still-retires-resource-idempotently");
  state.frame_available = true;
  state.frame.geometry_serial = 1;
  hvir_terminal_frame obsolete;
  REQUIRE(hvir_terminal_take_frame(&host, state.id, &obsolete) == HVIR_PRESENTATION &&
          !state.frame_available && !state.failure,
          "obsolete-frame-discard-reports-rearm-failure-without-parser-failure");
  state.surface = NULL;
  host.states = NULL;
  hvir_ghostty_external_frame frame = {
    .kind = 2, .width = 16, .height = 16, .plane_count = 5,
    .fds = {fd, fd, fd, fd}, .strides = {64, 64, 64, 64}
  };
  /* fds[4] would alias strides[0]. Make an out-of-bounds cleanup observable
   * even without an ASan field redzone, independently of callback rejection. */
  state.frame = (hvir_terminal_frame){.kind = 2, .plane_count = 5,
    .fds = {-1, -1, -1, -1}, .strides = {(uint32_t)fd, 0, 0, 0}};
  clear_frame(&state);
  REQUIRE(fcntl(fd, F_GETFD) >= 0 && descriptor_count() == baseline,
          "clear-frame-never-indexes-fifth-descriptor");
  REQUIRE(rejected(&state, &frame, fd, baseline), "oversized-plane-count-bounded-cleanup");
  frame.plane_count = 1;
  frame.fds[0] = -1;
  REQUIRE(rejected(&state, &frame, fd, baseline), "invalid-descriptor-explicit-failure");
  frame.plane_count = 2;
  frame.fds[0] = fd;
  frame.fds[1] = -1;
  REQUIRE(rejected(&state, &frame, fd, baseline), "partial-duplication-failure-closes-consumer-fd");
  frame.plane_count = 1;
  frame.fds[0] = pipes[0];
  REQUIRE(rejected(&state, &frame, fd, baseline) &&
          fcntl(pipes[0], F_GETFD) >= 0 && fcntl(pipes[1], F_GETFD) >= 0,
          "nonseekable-allocation-rejected-without-source-close");
  frame.kind = 99;
  frame.fds[0] = fd;
  REQUIRE(rejected(&state, &frame, fd, baseline), "unknown-kind-explicit-failure");
  const uint8_t pixel[4] = {0, 1, 2, 255};
  hvir_ghostty_external_frame pixels = {.kind = 3, .width = 1, .height = 1,
    .pixels = pixel, .pixel_bytes = sizeof(pixel)};
  fail_allocation = true;
  REQUIRE(rejected(&state, &pixels, fd, baseline) && !live_allocations &&
          !fail_allocation && pixel[0] == 0 && pixel[3] == 255,
          "pixel-copy-allocation-failure-cleans-consumer-metadata");
  host.states = &state;
  state.surface = (ghostty_surface_t)&state;
  host.external_feed = accept_feed;
  host.external_read = return_text;
  uint8_t readable[8];
  size_t readable_size = 0;
  hvir_terminal_status acquisition_status;
  REQUIRE(hvir_terminal_inspect(&host, state.id, &acquisition_status) == HVIR_OK &&
          !acquisition_status.failure && acquisition_status.presentation_failure &&
          hvir_terminal_take_frame(&host, state.id, &obsolete) == HVIR_PRESENTATION &&
          hvir_terminal_feed(&host, state.id, 1, (const uint8_t *)"ok", 2) == HVIR_OK &&
          hvir_terminal_read(&host, state.id, readable, sizeof(readable), &readable_size) == HVIR_OK &&
          readable_size == 2 && memcmp(readable, "ok", 2) == 0,
          "presentation-acquisition-failure-preserves-feed-and-read-owner-ports");
  frame.kind = 2;
  frame.plane_count = 2;
  frame.fds[1] = fd;
  REQUIRE(frame_ready(&state, &frame) && !state.failure && !state.presentation_failure && state.frame_available &&
          descriptor_count() == baseline + 2, "valid-planes-own-independent-duplicates");
  const int first = state.frame.fds[0], second = state.frame.fds[1];
  REQUIRE(first != fd && second != fd && first != second &&
          fcntl(first, F_GETFD) >= 0 && fcntl(second, F_GETFD) >= 0,
          "consumer-descriptors-are-not-producer-descriptors");
  clear_frame(&state);
  errno = 0;
  REQUIRE(fcntl(first, F_GETFD) == -1 && errno == EBADF,
          "first-consumer-descriptor-released");
  errno = 0;
  REQUIRE(fcntl(second, F_GETFD) == -1 && errno == EBADF &&
          fcntl(fd, F_GETFD) >= 0 && descriptor_count() == baseline,
          "second-consumer-released-and-producer-preserved");
  clear_frame(&state);
  REQUIRE(descriptor_count() == baseline && fcntl(fd, F_GETFD) >= 0,
          "repeated-clear-has-no-descriptor-effect");
#ifdef __APPLE__
  const int32_t width_value = 3, height_value = 2, element_value = 4;
  const int32_t format_value = 0x42475241;
  const void *surface_keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement,
                                kIOSurfacePixelFormat};
  CFNumberRef surface_values[] = {
    CFNumberCreate(NULL, kCFNumberSInt32Type, &width_value),
    CFNumberCreate(NULL, kCFNumberSInt32Type, &height_value),
    CFNumberCreate(NULL, kCFNumberSInt32Type, &element_value),
    CFNumberCreate(NULL, kCFNumberSInt32Type, &format_value)};
  CFDictionaryRef properties = CFDictionaryCreate(NULL, surface_keys, (const void **)surface_values,
    4, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  copy_surface = IOSurfaceCreate(properties);
  CFRelease(properties);
  for (unsigned i = 0; i < 4; i++) CFRelease(surface_values[i]);
  REQUIRE(copy_surface, "create-real-iosurface-copy-fixture");
  REQUIRE(IOSurfaceLock(copy_surface, 0, NULL) == kIOReturnSuccess, "lock-copy-fixture");
  const uint8_t packed[24] = {1,2,200,255,4,5,6,255,7,8,9,255,
                              101,102,103,255,104,105,106,255,107,108,109,255};
  uint8_t *base = IOSurfaceGetBaseAddress(copy_surface);
  const size_t row_size = IOSurfaceGetBytesPerRow(copy_surface);
  memcpy(base, packed, 12); memcpy(base + row_size, packed + 12, 12);
  REQUIRE(IOSurfaceUnlock(copy_surface, 0, NULL) == kIOReturnSuccess, "unlock-copy-fixture");
  host.states = &state;
  state.geometry = (hvir_terminal_geometry){.serial = 7, .width = 3, .height = 2, .backing_scale = 1};
  hvir_ghostty_external_frame pixel_frame = {.kind = 1, .width = 3, .height = 2, .geometry = 7,
    .fourcc = 0x42475241, .surface = copy_surface};
  REQUIRE(frame_ready(&state, &pixel_frame), "accept-real-completed-iosurface-fixture");
  CFRelease(copy_surface); copy_surface = NULL;
  hvir_terminal_frame pixel_lease;
  REQUIRE(hvir_terminal_take_frame(&host, state.id, &pixel_lease) == HVIR_OK &&
          !state.frame_copies, "acquisition-does-not-copy-pixels");
  uint8_t copied[24]; size_t copied_bytes = 99; uint32_t copied_stride = 99;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, pixel_lease.lease, copied, 23,
          &copied_bytes, &copied_stride) == HVIR_BOUND && !copied_bytes && !copied_stride &&
          !state.frame_copies, "copy-capacity-rejection-does-not-copy-or-count");
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, pixel_lease.lease + 1, copied, 24,
          &copied_bytes, &copied_stride) == HVIR_INVALID && !state.frame_copies,
          "copy-rejects-foreign-lease");
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, pixel_lease.lease, copied, 24,
          &copied_bytes, &copied_stride) == HVIR_OK && copied_bytes == 24 && copied_stride == 12 &&
          !memcmp(copied, packed, 24) && state.frame_copies == 1 && state.frame_taken,
          "copy-exact-packed-bgra-and-preserves-held-lease");
  state.closing = true;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, pixel_lease.lease, copied, 24,
          &copied_bytes, &copied_stride) == HVIR_OK && state.frame_copies == 2,
          "copy-held-resource-after-engine-retirement");
  state.closing = false;
  clear_frame(&state);
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, pixel_lease.lease, copied, 24,
          &copied_bytes, &copied_stride) == HVIR_INVALID && state.frame_copies == 2,
          "released-resource-cannot-be-copied-or-counted");
#endif
  const uint8_t opaque = 42;
  for (unsigned i = 0; i < 128; i++) {
    const uint8_t item = (uint8_t)i;
    REQUIRE(effect(&state, 9, &item, 1), "fill-noncoalescible-fifo");
  }
  for (unsigned i = 0; i < 300; i++) renderer_health(&state, i % 2);
  renderer_health(&state, GHOSTTY_RENDERER_HEALTH_UNHEALTHY);
  const uint64_t health_geometry = state.geometry.serial;
  REQUIRE(hvir_terminal_inspect(&host, state.id, &acquisition_status) == HVIR_OK &&
          !acquisition_status.failure &&
          acquisition_status.renderer_health == GHOSTTY_RENDERER_HEALTH_UNHEALTHY &&
          state.event_count == 128, "health-flapping-does-not-consume-full-event-fifo");
  REQUIRE(hvir_terminal_take_frame(&host, state.id, &obsolete) == HVIR_PRESENTATION &&
          !state.failure && !state.closing && state.geometry.serial == health_geometry,
          "native-unhealthy-no-frame-is-presentation-unavailable-without-retiring-parser");
  state.applied_sequence = 0;
  REQUIRE(hvir_terminal_feed(&host, state.id, 1, (const uint8_t *)"ok", 2) == HVIR_OK &&
          hvir_terminal_read(&host, state.id, readable, sizeof(readable), &readable_size) == HVIR_OK &&
          readable_size == 2 && !memcmp(readable, "ok", 2),
          "renderer-health-preserves-parser-owner-ports-with-full-fifo");
  renderer_health(&state, GHOSTTY_RENDERER_HEALTH_HEALTHY);
  REQUIRE(hvir_terminal_inspect(&host, state.id, &acquisition_status) == HVIR_OK &&
          acquisition_status.renderer_health == GHOSTTY_RENDERER_HEALTH_HEALTHY &&
          !acquisition_status.failure && !acquisition_status.closing &&
          hvir_terminal_take_frame(&host, state.id, &obsolete) == HVIR_BUSY &&
          state.geometry.serial == health_geometry,
          "native-health-recovery-without-frame-is-busy-not-presentation-failure");
  state.geometry = (hvir_terminal_geometry){.serial = health_geometry, .backing_scale = 1,
    .width = 1, .height = 1};
  state.requested_geometry = health_geometry;
  pixels.geometry = health_geometry;
  REQUIRE(frame_ready(&state, &pixels) &&
          hvir_terminal_take_frame(&host, state.id, &obsolete) == HVIR_OK &&
          obsolete.geometry_serial == health_geometry && !state.failure && !state.closing,
          "healthy-replacement-frame-can-be-acquired-after-renderer-failure");
  clear_frame(&state);
  uint8_t cwd[4097];
  for (size_t i = 0; i < sizeof(cwd); i++) cwd[i] = i % 128 ? 'b' : '/';
  hvir_terminal_event event;
  REQUIRE(effect(&state, 2, cwd, 4096) &&
          hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
          event.kind == 2 && event.length == 4096 && !event.truncated &&
          !memcmp(event.data, cwd, 4096), "full-bound-cwd-retained-exactly");
  for (unsigned i = 0; i < 300; i++) {
    cwd[1] = (uint8_t)('a' + i % 26);
    REQUIRE(effect(&state, 2, cwd, sizeof(cwd)) &&
            effect(&state, 1, &cwd[1], 1), "replace-bounded-latest-metadata-with-full-fifo");
  }
  REQUIRE(state.event_count == 128 && !state.failure && !live_allocations &&
          hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
          event.kind == 1 && event.length == 1 && !event.truncated &&
          event.data[0] == cwd[1], "title-replacements-retain-only-latest-value");
  REQUIRE(hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
          event.kind == 2 && event.length == 4096 && event.truncated &&
          !memcmp(event.data, cwd, 4096), "oversized-cwd-truncation-is-explicit");
  for (unsigned i = 0; i < 128; i++)
    REQUIRE(hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
            event.kind == 9 && event.length == 1 && !event.truncated &&
            event.data[0] == (uint8_t)i, "noncoalescible-fifo-remains-ordered-and-intact");
  REQUIRE(hvir_terminal_next_event(&host, state.id, &event) == HVIR_BUSY,
          "coalesced-metadata-and-fifo-drain-exactly");
  for (unsigned i = 0; i < 128; i++)
    REQUIRE(effect(&state, 9, &opaque, 1), "refill-noncoalescible-fifo");
  REQUIRE(!effect(&state, 9, &opaque, 1) && state.failure && state.event_count == 128 &&
          hvir_terminal_feed(&host, state.id, 2, (const uint8_t *)"ok", 2) == HVIR_FAILED,
          "noncoalescible-overflow-remains-bounded-explicit-failure");
  result = 0;
cleanup:
#ifdef __APPLE__
  if (copy_surface) CFRelease(copy_surface);
#endif
  clear_frame(&state);
  if (pipes[0] >= 0) close(pipes[0]);
  if (pipes[1] >= 0) close(pipes[1]);
  if (source) fclose(source);
  pthread_cond_destroy(&host.changed);
  pthread_mutex_destroy(&host.events);
  if (!result) printf("{\"schema\":1,\"frameMetadataAdapter\":\"passed\","
    "\"checks\":%u,\"descriptorCountChecked\":true,\"nativeEngineInitialized\":false}\n", checks);
  return result;
}
