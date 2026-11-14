#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <stdbool.h>
static bool fail_allocation;
static unsigned live_allocations;
static unsigned allocation_attempts;
static void *probe_malloc(size_t size) {
  allocation_attempts++;
  if (fail_allocation) { fail_allocation = false; return NULL; }
  void *value = malloc(size);
  if (value) live_allocations++;
  return value;
}
static void *probe_calloc(size_t count, size_t size) {
  allocation_attempts++;
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
#include "terminal_input.c"
#include "terminal_effects.c"
#undef malloc
#undef calloc
#undef free
#include <dirent.h>
#include <errno.h>
#include <stdio.h>

static uint64_t effect_serial;
static bool effect(terminal_state *state, uint32_t kind, const uint8_t *data, size_t length) {
  const hvir_ghostty_external_effect event = {.kind=kind,.sequence=17,
    .serial=++effect_serial,.data=data,.data_len=length};
  return hvir_internal_effect(state,&event);
}
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
static size_t input_capacity = 8;
static unsigned input_calls;
static uint32_t input_mode;
static bool input_size(ghostty_surface_t surface, const hvir_ghostty_input_event *event,
    bool read_only, size_t *capacity) {
  (void)surface; (void)read_only;
  *capacity = event->kind == HVIR_INPUT_PREEDIT ? 0 : input_capacity;
  return true;
}
static uint32_t input_call(ghostty_surface_t surface, const hvir_ghostty_input_event *event,
    uint64_t serial, bool read_only, size_t capacity, hvir_ghostty_input_result *result) {
  (void)read_only;
  terminal_state *state = (terminal_state *)surface;
  input_calls++;
  if (input_mode == 1) { result->required_capacity = capacity + 1; return 2; }
  if (input_mode == 2) return 1;
  if (event->kind == HVIR_INPUT_KEY) {
    const uint8_t bytes[2] = {1, 2};
    if (!hvir_internal_input(state, input_mode == 3 ? 3 : 1, bytes,
        input_mode == 4 ? sizeof(bytes) : 1)) return 1;
  }
  if (serial) hvir_internal_mutation_applied(state, serial);
  return 0;
}
static bool input_faults(void) {
  hvir_terminal_host host = {.caller=pthread_self(), .app_tick=idle_tick,
    .external_input_capacity=input_size, .external_input=input_call,
    .external_feed=accept_feed, .external_read=return_text};
  terminal_state state = {.host=&host, .id=1, .requested_geometry=1,
    .geometry={.serial=1}};
  state.surface = (ghostty_surface_t)&state; host.states = &state;
  if (pthread_mutex_init(&host.events, NULL)) return false;
  if (pthread_cond_init(&host.changed, NULL)) { pthread_mutex_destroy(&host.events); return false; }
  bool ok = false; hvir_terminal_input_result result = {0};
  hvir_terminal_input_event key = {.kind=HVIR_INPUT_KEY, .key=GHOSTTY_KEY_ENTER, .action=1};
#define INPUT_REQUIRE(value, name) do { if (!verify((value), (name))) goto finish; } while (0)
  input_mode=0; input_calls=0; input_capacity=8; fail_allocation=true;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_NOMEM &&
    input_calls == 0 && !state.requested_mutation && !state.input_failure && !live_allocations &&
    !result.data && !result.requested_mutation,
    "input-result-allocation-failure-is-premutation-and-unpublished");
  input_capacity=HVIR_TERMINAL_INPUT_SMALL_MAX+1;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_BOUND &&
    !input_calls && !state.requested_mutation && !state.input_failure && !live_allocations,
    "input-admission-bound-precedes-native-mutation");
  input_capacity=8; input_mode=1;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_BUSY &&
    result.capacity == 9 && !result.data && !result.requested_mutation &&
    !state.requested_mutation && !state.input_failure && !live_allocations,
    "native-capacity-recheck-refusal-is-proven-unsent-with-no-sticky-failure");
  input_mode=0;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_OK &&
    result.length == 1 && result.capacity == 8 && result.source == 1 &&
    result.requested_mutation == 1 && state.io_applied_mutation == 1 && live_allocations == 1,
    "fresh-key-after-premutation-capacity-refusal-works");
  hvir_terminal_input_result_free(&result);
  INPUT_REQUIRE(!live_allocations && !result.data && !result.capacity,
    "owned-input-result-release-clears-pointer-and-capacity");
  hvir_internal_mutation_applied(&state, 1); hvir_internal_mutation_applied(&state, 100);
  INPUT_REQUIRE(state.io_applied_mutation == 1, "late-or-unrequested-input-ack-cannot-advance");
  state.closing=true; state.requested_mutation=2; hvir_internal_mutation_applied(&state, 2);
  feed_applied(&state, 2);
  INPUT_REQUIRE(state.io_applied_mutation == 1 && !state.io_applied_sequence,
    "closing-state-ignores-late-input-and-feed-completion");
  state.closing=false; state.requested_mutation=1;
  feed_applied(&state, 2); feed_applied(&state, 1);
  INPUT_REQUIRE(state.io_applied_sequence == 2, "feed-io-fence-is-monotonic-and-independent");
  input_mode=3;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_FAILED &&
    state.input_failure && !state.failure && !result.data && !live_allocations,
    "invalid-input-source-revokes-input-without-poisoning-parser-or-leaking-result");
  state.input_failure=0; input_mode=4; input_capacity=1;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_FAILED &&
    state.input_failure && !state.failure && !result.data && !live_allocations,
    "capture-overflow-never-publishes-partial-owned-input");
  state.input_failure=0; input_mode=2; input_capacity=8;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1, &key, false, &result) == HVIR_FAILED &&
    state.input_failure && result.requested_mutation && !state.failure && !live_allocations,
    "postmutation-native-error-has-token-but-no-replayable-body");
  input_mode=0; fail_allocation=true;
  INPUT_REQUIRE(hvir_terminal_input(&host, 1,
    &(hvir_terminal_input_event){.kind=HVIR_INPUT_PREEDIT}, false, &result) == HVIR_OK &&
    !result.data && !result.capacity && fail_allocation && !live_allocations,
    "zero-byte-cleanup-remains-available-without-allocation-after-input-failure");
  fail_allocation=false;
  uint8_t text[4]; size_t length=0;
  INPUT_REQUIRE(hvir_terminal_feed(&host, 1, 1, (const uint8_t *)"ok", 2) == HVIR_OK &&
    hvir_terminal_read(&host, 1, text, sizeof(text), &length) == HVIR_OK && length == 2 &&
    !memcmp(text, "ok", 2) && !state.failure && state.input_failure,
    "input-failure-preserves-authoritative-parser-feed-and-read");
  ok=true;
finish:
  fail_allocation=false;
  hvir_terminal_input_result_free(&result);
  pthread_cond_destroy(&host.changed); pthread_mutex_destroy(&host.events);
  return ok;
#undef INPUT_REQUIRE
}
static bool reject_rearm(ghostty_surface_t surface) { (void)surface; return false; }

static uint64_t pending_geometry;
static hvir_ghostty_external_config observed_config;
static ghostty_surface_t begin_native_create(ghostty_app_t app, void *display,
    const hvir_ghostty_external_config *config, uint32_t width, uint32_t height) {
  (void)app; (void)display; (void)width; (void)height;
  observed_config = *config;
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
  if (!input_faults()) return 1;
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
  REQUIRE(observed_config.pixel_export_limit == 16u * 1024u * 1024u &&
          observed_config.presentation_mode == 0 && observed_config.renderer_info &&
          observed_config.write && observed_config.applied && observed_config.frame,
          "external-config-explicit-limit-initial-auto-and-renderer-info-hook");
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
  host.initial_presentation_mode = 1;
  REQUIRE(hvir_terminal_create_begin(&host, 640, 480, &unpublished_id) == HVIR_OK &&
          observed_config.presentation_mode == 1 &&
          observed_config.pixel_export_limit == HVIR_TERMINAL_PIXEL_MAX &&
          hvir_terminal_destroy(&host, unpublished_id) == HVIR_OK && !live_allocations,
          "explicit-pixels-reaches-initial-native-config-before-first-frame");
  host.initial_presentation_mode = 0;
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
  hvir_terminal_renderer_info native_info;
  REQUIRE(hvir_terminal_renderer_info_get(&host, state.id, &native_info) == HVIR_OK &&
          !native_info.available && !native_info.gl_vendor[0] && !native_info.render_node[0],
          "no-native-gl-callback-remains-unknown-including-metal");
  uint8_t long_vendor[1024]; memset(long_vendor, 'v', sizeof(long_vendor));
  hvir_ghostty_renderer_info diagnostic = {
    .gl_vendor = long_vendor, .gl_vendor_len = sizeof(long_vendor),
    .gl_renderer = (const uint8_t *)"actual-renderer", .gl_renderer_len = 15,
    .gl_version = (const uint8_t *)"4.3", .gl_version_len = 3,
    .egl_vendor = NULL, .egl_vendor_len = 100,
    .egl_version = (const uint8_t *)"1.5", .egl_version_len = 3,
  };
  renderer_info(&state, &diagnostic);
  memset(long_vendor, 'x', sizeof(long_vendor));
  REQUIRE(hvir_terminal_renderer_info_get(&host, state.id, &native_info) == HVIR_OK &&
          native_info.available && strlen(native_info.gl_vendor) == 255 &&
          native_info.gl_vendor[0] == 'v' && native_info.gl_vendor[254] == 'v' &&
          !strcmp(native_info.gl_renderer, "actual-renderer") &&
          !strcmp(native_info.gl_version, "4.3") && !native_info.egl_vendor[0] &&
          !strcmp(native_info.egl_version, "1.5") && !native_info.render_node[0],
          "native-render-info-copies-bounded-strings-and-preserves-unknown-fields");
  state.closing = true;
  renderer_info(&state, &diagnostic);
  state.closing = false;
  REQUIRE(state.renderer_info.gl_vendor[0] == 'v', "late-render-info-cannot-mutate-retired-state");
  const hvir_terminal_geometry prior_geometry = state.geometry;
  const uint64_t prior_requested = state.requested_geometry;
  state.geometry = (hvir_terminal_geometry){.serial = 7, .width = 2, .height = 2, .backing_scale = 1};
  state.requested_geometry = 7;
  const uint8_t rgba[16] = {200,2,3,255,4,105,6,128,7,8,109,64,10,11,12,0};
  const uint8_t bgra[16] = {3,2,200,255,6,105,4,128,109,8,7,64,12,11,10,0};
  hvir_ghostty_external_frame owned = {.kind = 3, .width = 2, .height = 2,
    .geometry = 7, .stream = state.applied_sequence, .pixels = rgba, .pixel_bytes = sizeof(rgba),
    .origin = 2, .color_space = 1, .premultiplied = 1};
  const uint64_t before_pixel_frames = state.renderer_info.pixel_frames;
  REQUIRE(frame_ready(&state, &owned) && state.renderer_info.pixel_frames == before_pixel_frames + 1,
          "owned-pixel-export-is-counted-before-explicit-copy");
  hvir_terminal_frame rgba_lease;
  REQUIRE(hvir_terminal_take_frame(&host, state.id, &rgba_lease) == HVIR_OK &&
          rgba_lease.origin == 2 && rgba_lease.color_space == 1 && rgba_lease.premultiplied,
          "held-owned-pixels-preserve-color-origin-alpha-metadata");
  uint8_t converted[16]; size_t written = 99; uint32_t stride = 99;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted, 15,
          &written, &stride) == HVIR_BOUND && !written && !stride && !state.frame_copies,
          "owned-copy-capacity-is-checked-before-readback-or-count");
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease + 1, converted, 16,
          &written, &stride) == HVIR_INVALID && !state.frame_copies,
          "owned-copy-rejects-stale-lease");
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted, 16,
          &written, &stride) == HVIR_OK && written == 16 && stride == 8 &&
          !memcmp(converted, bgra, 16) && !memcmp(state.frame.pixels, rgba, 16) &&
          !memcmp(owned.pixels, rgba, 16) && state.frame_taken && state.frame_copies == 1,
          "actual-owned-rgba-copy-converts-bgra-without-mutating-or-releasing-source");
  state.frame.pixel_bytes = 15;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted, 16,
          &written, &stride) == HVIR_PRESENTATION && !written && !stride && state.frame_copies == 1,
          "malformed-owned-byte-size-refuses-copy");
  state.frame.pixel_bytes = 16;
  state.frame.width = 4096; state.frame.height = 1025;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted, 16,
          &written, &stride) == HVIR_BOUND && !written && !stride && state.frame_copies == 1,
          "over-16mib-copy-refuses-before-accessing-source");
  state.frame.width = 2; state.frame.height = 2;
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted,
          HVIR_TERMINAL_PIXEL_MAX + 1u, &written, &stride) == HVIR_BOUND && state.frame_copies == 1,
          "output-capacity-cannot-exceed-copy-budget");
  clear_frame(&state);
  REQUIRE(hvir_terminal_copy_frame(&host, state.id, rgba_lease.lease, converted, 16,
          &written, &stride) == HVIR_INVALID && state.frame_copies == 1,
          "released-owned-lease-cannot-copy");
  state.frame_copies = 0;
  state.geometry = prior_geometry; state.requested_geometry = prior_requested;
  owned.width = 4096; owned.height = 1025; owned.pixel_bytes = HVIR_TERMINAL_PIXEL_MAX + 4096u;
  REQUIRE(rejected(&state, &owned, fd, baseline) && !live_allocations,
          "over-16mib-export-refuses-before-allocating-or-reading-small-source");
  state.presentation_failure = 0;
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
  hvir_terminal_event event;
  for (unsigned i = 0; i < 128; i++)
    REQUIRE(hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
            event.kind == 9 && event.sequence == 17 && event.length == 1 &&
            !event.truncated && event.data[0] == (uint8_t)i,
            "health-preserves-ordered-copied-fifo");
  REQUIRE(!live_allocations && !state.effect_bytes, "fifo-drain-frees-owned-payloads");
  uint8_t cwd[4097];
  memset(cwd, 'b', sizeof(cwd)); cwd[0]='/';
  REQUIRE(effect(&state, 2, cwd, sizeof(cwd)) &&
          hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
          event.kind == 2 && event.length == sizeof(cwd) && !event.truncated &&
          !memcmp(event.data, cwd, sizeof(cwd)), "cwd-copy-is-complete-not-truncated");
  for (unsigned i = 0; i < 128; i++)
    REQUIRE(effect(&state, 9, &opaque, 1), "fill-fifo-for-coalesced-metadata");
  for (unsigned i = 0; i < 300; i++) {
    cwd[1] = (uint8_t)('a' + i % 26);
    REQUIRE(effect(&state, 2, cwd, sizeof(cwd)) &&
            effect(&state, 1, &cwd[1], 1) && effect(&state,3,NULL,0),
            "replace-latest-title-cwd-bell-with-full-fifo");
  }
  REQUIRE(state.event_count == 128 && !state.failure && live_allocations == 130 &&
          state.effect_bytes == 128 + sizeof(cwd) + 1,
          "coalesced-bell-and-metadata-have-bounded-owned-storage");
  for (unsigned i = 0; i < 128; i++)
    REQUIRE(hvir_terminal_next_event(&host, state.id, &event) == HVIR_OK &&
            event.kind == 9 && event.length == 1 && event.data[0] == opaque,
            "fifo-precedes-newer-coalesced-occurrences");
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK && event.kind==2 &&
          event.length==sizeof(cwd) && !memcmp(event.data,cwd,sizeof(cwd)) && !event.truncated,
          "latest-cwd-full-bytes-preserved");
  const uint64_t cwd_serial=event.event_serial;
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK && event.kind==1 &&
          event.length==1 && event.data[0]==cwd[1] && event.event_serial>cwd_serial,
          "latest-title-preserves-causal-order");
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK && event.kind==3 &&
          hvir_terminal_next_event(&host,state.id,&event)==HVIR_BUSY && !live_allocations,
          "coalesced-bell-drains-once-and-all-payloads-freed");
  static uint8_t full[65536]; memset(full,'Y',sizeof(full));
  uint8_t selection[]={'p','c'};
  hvir_ghostty_external_effect clipboard={.kind=5,.sequence=29,.serial=++effect_serial,
    .data=full,.data_len=sizeof(full),.extra=selection,.extra_len=sizeof(selection)};
  REQUIRE(hvir_internal_effect(&state,&clipboard) && state.effect_bytes==65538 &&
          live_allocations==1,"complete-64k-clipboard-and-selection-owned-together");
  full[0]='Z'; selection[0]='x';
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK && event.kind==5 &&
          event.sequence==29 && event.event_serial==clipboard.serial && event.length==65536 &&
          event.extra_length==2 && event.data[0]=='Y' && event.data[65535]=='Y' &&
          !memcmp(event.extra,"pc",2) && !live_allocations && !state.effect_bytes,
          "callback-borrowed-bytes-copied-before-source-mutation");
  hvir_terminal_effect_status status;
  REQUIRE(hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          !status.dropped_effects && !status.semantic_generation,"initial-effect-status-clean");
  REQUIRE(effect(&state,1,(const uint8_t *)"old",3),"allocate-latest-title-for-refusal");
  fail_allocation=true;
  REQUIRE(effect(&state,1,(const uint8_t *)"new",3) && !state.failure && live_allocations==1 &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.dropped_effects==1 && status.semantic_generation==1,
          "allocation-refusal-preserves-parser-and-sticky-out-of-band-gap");
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK && event.length==3 &&
          !memcmp(event.data,"old",3) && !live_allocations,
          "failed-replacement-keeps-prior-owned-title");
  clipboard.data_len=65537;
  REQUIRE(hvir_internal_effect(&state,&clipboard) && !state.failure && !live_allocations,
          "oversized-payload-refused-without-copy-or-parser-failure");
  clipboard.data_len=1; clipboard.data=NULL;
  REQUIRE(hvir_internal_effect(&state,&clipboard) && !state.failure && !live_allocations,
          "malformed-borrowed-pointer-refused-without-poison");
  for(unsigned i=0;i<128;i++) REQUIRE(effect(&state,9,&opaque,1),"refill-fifo-for-sticky-gap");
  REQUIRE(effect(&state,6,&opaque,1) && !state.failure && state.event_count==128 &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.dropped_effects==4 && status.semantic_generation==4 && status.queued_bytes==128,
          "full-fifo-semantic-gap-readable-without-an-extra-event");
  state.applied_sequence=0;
  REQUIRE(hvir_terminal_feed(&host,state.id,1,(const uint8_t *)"ok",2)==HVIR_OK &&
          hvir_terminal_read(&host,state.id,readable,sizeof(readable),&readable_size)==HVIR_OK &&
          readable_size==2 && !memcmp(readable,"ok",2),
          "effect-pressure-preserves-feed-and-read-ports");
  hvir_internal_clear_effects(&state);
  REQUIRE(!state.event_count && !state.effect_bytes && !live_allocations &&
          hvir_terminal_next_event(&host,state.id,&event)==HVIR_BUSY &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.dropped_effects==4 && status.semantic_generation==4,
          "clear-frees-all-payloads-with-sticky-gap-still-observable");
  clipboard.kind=6; clipboard.data=full; clipboard.data_len=sizeof(full);
  clipboard.extra=full; clipboard.extra_len=sizeof(full);
  for(unsigned i=0;i<8;i++) {
    clipboard.serial=++effect_serial;
    REQUIRE(hvir_internal_effect(&state,&clipboard),"fill-total-owned-effect-byte-budget");
  }
  REQUIRE(hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.queued_bytes==1024*1024 && live_allocations==8,
          "total-pair-payload-budget-is-one-mib");
  REQUIRE(effect(&state,1,&opaque,1) && !state.failure &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.queued_bytes==1024*1024 && status.dropped_effects==5 &&
          status.semantic_generation==5 && live_allocations==8,
          "latest-slots-share-total-budget-and-refuse-with-sticky-gap");
  const unsigned before_full_bell=allocation_attempts;
  REQUIRE(effect(&state,3,NULL,0) && allocation_attempts==before_full_bell &&
          state.effect_bytes==1024*1024 && live_allocations==8 && !state.failure,
          "zero-byte-bell-admitted-at-literal-full-payload-budget");
  hvir_internal_clear_effects(&state);
  REQUIRE(!live_allocations && !state.effect_bytes,"clear-full-byte-budget-frees-every-pair");
  uint8_t pending_title[32]; memset(pending_title,'o',sizeof(pending_title));
  REQUIRE(effect(&state,1,pending_title,sizeof(pending_title)),
          "queue-old-title-before-near-full-payload-pressure");
  clipboard.data_len=sizeof(full); clipboard.extra_len=sizeof(full);
  for(unsigned i=0;i<7;i++) {
    clipboard.serial=++effect_serial;
    REQUIRE(hvir_internal_effect(&state,&clipboard),"fill-payloads-alongside-pending-title");
  }
  clipboard.extra_len=sizeof(full)-48; clipboard.serial=++effect_serial;
  REQUIRE(hvir_internal_effect(&state,&clipboard) &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.queued_bytes==1024*1024-16 && live_allocations==9,
          "near-full-budget-includes-old-coalesced-title");
  const unsigned before_replacement=allocation_attempts;
  REQUIRE(effect(&state,1,(const uint8_t *)"same-size-replacement-32-bytes---",32) &&
          allocation_attempts==before_replacement && !state.failure &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.queued_bytes==1024*1024-16 && status.dropped_effects==6 &&
          status.semantic_generation==6 && live_allocations==9,
          "same-size-replacement-refused-before-transient-allocation");
  REQUIRE(effect(&state,1,full,48) && allocation_attempts==before_replacement &&
          !state.failure && hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.queued_bytes==1024*1024-16 && status.dropped_effects==7 &&
          status.semantic_generation==7 && live_allocations==9,
          "expanded-replacement-cannot-spend-old-payload-before-copy");
  REQUIRE(effect(&state,3,NULL,0) && allocation_attempts==before_replacement &&
          state.effect_bytes==1024*1024-16 && !state.failure,
          "zero-byte-bell-remains-admissible-under-payload-pressure");
  REQUIRE(hvir_terminal_next_event(&host,state.id,&event)==HVIR_OK &&
          event.kind==1 && event.length==sizeof(pending_title) &&
          !memcmp(event.data,pending_title,sizeof(pending_title)) && live_allocations==8,
          "refused-replacements-preserve-complete-old-title");
  state.applied_sequence=0;
  REQUIRE(hvir_terminal_feed(&host,state.id,1,(const uint8_t *)"ok",2)==HVIR_OK &&
          hvir_terminal_read(&host,state.id,readable,sizeof(readable),&readable_size)==HVIR_OK &&
          readable_size==2 && !memcmp(readable,"ok",2),
          "coalesced-budget-refusal-preserves-parser-ports");
  hvir_internal_clear_effects(&state);
  REQUIRE(!state.effect_bytes && !live_allocations && !state.event_count &&
          hvir_terminal_effects_status(&host,state.id,&status)==HVIR_OK &&
          status.dropped_effects==7 && status.semantic_generation==7,
          "near-full-coalesced-cleanup-frees-all-payloads-retains-gap");
  REQUIRE(effect(&state,2,(const uint8_t *)"/held",5),"queue-payload-before-close");
  state.closing=true;
  REQUIRE(!effect(&state,1,&opaque,1) && live_allocations==1,
          "late-callback-rejected-on-closing-state");
  hvir_internal_clear_effects(&state);
  hvir_internal_clear_effects(&state);
  REQUIRE(!live_allocations && !state.effect_bytes,"close-cleanup-idempotently-frees-owned-payloads");
  result = 0;
cleanup:
#ifdef __APPLE__
  if (copy_surface) CFRelease(copy_surface);
#endif
  clear_frame(&state);
  hvir_internal_clear_effects(&state);
  if (pipes[0] >= 0) close(pipes[0]);
  if (pipes[1] >= 0) close(pipes[1]);
  if (source) fclose(source);
  pthread_cond_destroy(&host.changed);
  pthread_mutex_destroy(&host.events);
  if (!result) printf("{\"schema\":1,\"frameMetadataAdapter\":\"passed\","
    "\"checks\":%u,\"descriptorCountChecked\":true,\"nativeEngineInitialized\":false}\n", checks);
  return result;
}
