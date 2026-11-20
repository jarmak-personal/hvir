#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "terminal_internal.h"
#include "resource_edge.h"
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <IOSurface/IOSurface.h>
#endif

/* Opt-in package proof, never a production recovery policy or headless gate.
 * Parent has no Ghostty host/threads. A fresh posix_spawn child owns the SAME
 * parser throughout one case. Only the existing authenticated resource edge
 * transfers GPU handles; these private pipes carry fixed probe facts/acks.
 * Pixel hashing is qualification readback, never the normal rendering path. */
extern char **environ;
enum { WAIT_MS = 10000, EDGE_MS = 2000, CASE_MS = 25000, FRESH_FRAMES = 6 };
enum { FRAME = 1, FENCE = 2, COMPLETE = 3, FAILURE = 4, HELD_CALLBACK = 5 };
enum {
  START = 1, OPEN, CREATE, INITIAL_GEOMETRY, FEED, ACQUIRE, SEND, ACK,
  RESIZE_BEFORE, HIDE_BEFORE, BEGIN, STATUS, RESIZE_AFTER, HIDE_AFTER,
  SOURCE_RELEASE, FRESH, LATE_STATUS, TEARDOWN, CLEANUP, RECEIPT, PIXELS, CHILD_EXIT,
  CALLBACK_TAIL
};
static const char *const stages[] = {
  "none", "start", "open", "create", "initial-geometry", "feed", "acquire",
  "send", "ack", "resize-before", "hide-before", "begin", "status",
  "resize-after", "hide-after", "source-release", "fresh", "late-status",
  "teardown", "cleanup", "receipt", "pixels", "child-exit", "callback-tail"
};
enum { STABLE = 0, RESIZE_OLD, RESIZE_NEW, HIDDEN_OLD, HIDDEN_NEW, ENDED, CASES };
static const char *const names[] = {
  "stable", "resize-before-fence", "resize-after-fence", "hidden-before-fence",
  "hidden-after-fence", "joined-actor-ended"
};
typedef struct {
  uint32_t kind, stage, index, code, retirement, screen;
  uint64_t actor, lease, request, sequence, geometry, mutation;
  hvir_resource_metadata metadata;
} message;
typedef struct {
  hvir_terminal_host *host;
  hvir_terminal_id actor;
  uint64_t held, sequence, geometry, expected_mutation, deadline;
  uint32_t width, height, stage;
  hvir_terminal_result code;
} producer;
typedef struct {
  unsigned index, frames, unchanged_checks;
  uint32_t stage, code, retirement;
  uint64_t actor, lease, request, original_hash;
  message original_source, offered_source;
  const char *failure;
  uint32_t surfaces[FRESH_FRAMES + 1];
  pid_t producer_pid;
  bool callback_tail_held, pending_release_refused;
  bool receipt, fence, complete, child_reaped, cleanup;
  int child_exit;
} result;

/* Immediate dependency wrapper in this probe ONLY. Preserve original userdata
 * and every other config callback. The real C callback publishes/retains A and
 * unlocks events; the real render-thread callback then waits before returning.
 * No producer/SDK test hook, callback replacement in product, or GPU copy. */
static struct {
  pthread_mutex_t mutex;
  pthread_cond_t changed;
  bool armed, entered, released, returned, expired;
  bool (*frame)(void *, const hvir_ghostty_external_frame *);
  ghostty_surface_t (*create)(ghostty_app_t, void *, const hvir_ghostty_external_config *,
                              uint32_t, uint32_t);
} tail = { .mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER };

static bool held_frame_callback(void *userdata, const hvir_ghostty_external_frame *frame) {
  const bool accepted = tail.frame(userdata, frame);
  if (!accepted || !tail.armed || frame->stream != 1 || frame->kind != 1) return accepted;
  pthread_mutex_lock(&tail.mutex);
  tail.entered = true;
  struct timespec until = {0};
  if (clock_gettime(CLOCK_REALTIME, &until)) tail.expired = true;
  until.tv_sec += WAIT_MS / 1000;
  while (!tail.released && !tail.expired) {
    const int waited = pthread_cond_timedwait(&tail.changed, &tail.mutex, &until);
    if (waited && waited != EINTR) tail.expired = true;
  }
  tail.returned = true;
  pthread_mutex_unlock(&tail.mutex);
  return accepted;
}
static ghostty_surface_t intercepted_surface(ghostty_app_t app, void *display,
    const hvir_ghostty_external_config *config, uint32_t width, uint32_t height) {
  hvir_ghostty_external_config copied = *config;
  tail.frame = config->frame;
  copied.frame = held_frame_callback;
  return tail.create(app, display, &copied, width, height);
}
static bool tail_is_held(void) {
  pthread_mutex_lock(&tail.mutex);
  const bool held = tail.entered && !tail.returned && !tail.released && !tail.expired;
  pthread_mutex_unlock(&tail.mutex);
  return held;
}
static bool release_tail(void) {
  pthread_mutex_lock(&tail.mutex);
  const bool valid = !tail.expired;
  tail.released = true;
  pthread_cond_broadcast(&tail.changed);
  pthread_mutex_unlock(&tail.mutex);
  return valid;
}

static uint64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
  return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}
static void pause_owner(void) {
  const struct timespec interval = { .tv_nsec = 1000000 };
  (void)nanosleep(&interval, NULL);
}
static uint64_t bound(uint64_t outer, unsigned interval) {
  const uint64_t local = now_ms() + interval;
  return outer < local ? outer : local;
}
static bool pipe_io(int fd, void *bytes, size_t length, bool writing, uint64_t deadline) {
  uint8_t *cursor = bytes;
  while (length) {
    const uint64_t now = now_ms();
    if (!now || now >= deadline) return false;
    struct pollfd ready = { .fd = fd, .events = writing ? POLLOUT : POLLIN };
    int selected;
    do { selected = poll(&ready, 1, (int)(deadline - now)); }
    while (selected < 0 && errno == EINTR);
    if (selected <= 0 || !(ready.revents & ready.events)) return false;
    const ssize_t amount = writing ? write(fd, cursor, length) : read(fd, cursor, length);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) return false;
    cursor += (size_t)amount;
    length -= (size_t)amount;
  }
  return true;
}
static bool send_message(const message *value, uint64_t deadline) {
  message copy = *value;
  return pipe_io(STDOUT_FILENO, &copy, sizeof(copy), true, deadline);
}
static bool child_ack(producer *p) {
  p->stage = ACK;
  uint32_t value = 0;
  return pipe_io(STDIN_FILENO, &value, sizeof(value), false, bound(p->deadline, WAIT_MS)) &&
    value == 1;
}
static bool okay(producer *p, hvir_terminal_result code) {
  p->code = code;
  return code == HVIR_OK;
}
static bool applied(producer *p) {
  const uint64_t deadline = bound(p->deadline, WAIT_MS);
  do {
    hvir_terminal_status status = {0};
    if (!okay(p, hvir_terminal_inspect(p->host, p->actor, &status)) ||
        status.failure || status.geometry_failure_serial) return false;
    if (status.geometry.serial == p->geometry)
      return status.geometry.width == p->width && status.geometry.height == p->height &&
        status.geometry.columns && status.geometry.rows;
    if (status.geometry.serial > p->geometry) return false;
    pause_owner();
  } while (now_ms() < deadline);
  p->code = HVIR_TIMEOUT;
  return false;
}
static bool resize(producer *p) {
  p->width = 704;
  p->height = 352;
  p->geometry++;
  return okay(p, hvir_terminal_resize(p->host, p->actor, p->geometry,
                                     p->width, p->height)) && applied(p);
}
static bool stage_content(producer *p, unsigned index) {
  char text[192], tag[48];
  (void)snprintf(tag, sizeof(tag), "HVIR_RETIRE_FRAME_%u", index);
  const int length = snprintf(text, sizeof(text),
    "\033[?25l\033[48;2;%u;%u;%um\033[2J\033[H%s", 20u + index * 29u,
    30u + index * 17u, 40u + index * 13u, tag);
  p->stage = FEED;
  if (length <= 0 || (size_t)length >= sizeof(text) ||
      !okay(p, hvir_terminal_feed(p->host, p->actor, p->sequence + 1,
                                  (const uint8_t *)text, (size_t)length))) return false;
  p->sequence++;
  const uint64_t deadline = bound(p->deadline, WAIT_MS);
  do {
    hvir_terminal_status status = {0};
    if (!okay(p, hvir_terminal_inspect(p->host, p->actor, &status)) || status.failure)
      return false;
    if (status.io_applied_sequence < p->sequence) { pause_owner(); continue; }
    char readback[8192];
    size_t written = 0;
    if (!okay(p, hvir_terminal_read(p->host, p->actor, (uint8_t *)readback,
                                    sizeof(readback) - 1, &written))) return false;
    if (written >= sizeof(readback)) return false;
    readback[written] = 0;
    if (!strstr(readback, tag)) { pause_owner(); continue; }
    p->expected_mutation = status.io_applied_mutation;
    return true;
  } while (now_ms() < deadline);
  p->code = HVIR_TIMEOUT;
  return false;
}
static bool acquire(producer *p, unsigned index, hvir_terminal_frame *frame) {
  p->stage = ACQUIRE;
  const uint64_t deadline = bound(p->deadline, WAIT_MS);
  do {
    p->code = hvir_terminal_take_frame(p->host, p->actor, frame);
    if (p->code == HVIR_BUSY) { pause_owner(); continue; }
    if (p->code != HVIR_OK) return false;
    p->held = frame->lease;
    if (frame->stream_sequence == p->sequence && frame->geometry_serial == p->geometry &&
        frame->snapshot_mutation >= p->expected_mutation && frame->kind == 1 &&
        frame->width == p->width && frame->height == p->height && frame->surface)
      return true;
    /* Initial construction can have published a blank before contentA. After
     * retirement every next content is IO-applied WHILE its predecessor is
     * held, so a stale fresh frame is a failure, not an invisible extra cycle. */
    if (index) return false;
    if (!okay(p, hvir_terminal_release_frame(p->host, p->actor, p->held))) return false;
    p->held = 0;
    pause_owner();
  } while (now_ms() < deadline);
  p->code = HVIR_TIMEOUT;
  return false;
}
static hvir_resource_frame borrowed_resource(const hvir_terminal_frame *frame) {
  hvir_resource_frame resource = {0};
  resource.surface = frame->surface;
  resource.metadata = (hvir_resource_metadata){
    .kind = frame->kind, .width = frame->width, .height = frame->height,
    .fourcc = frame->fourcc, .premultiplied = frame->premultiplied,
    .color_space = frame->color_space, .origin = frame->origin,
    .plane_count = frame->plane_count, .modifier = frame->modifier
  };
  for (unsigned n = 0; n < 4; n++) {
    resource.fds[n] = frame->fds[n];
    resource.metadata.strides[n] = frame->strides[n];
    resource.metadata.offsets[n] = frame->offsets[n];
    resource.metadata.sizes[n] = frame->sizes[n];
  }
  return resource;
}
static bool transfer(producer *p, const hvir_terminal_frame *frame, unsigned index,
                     const char *address, const char *ticket, int peer) {
  p->stage = SEND;
  hvir_resource_frame resource = borrowed_resource(frame);
  const message value = {
    .kind = FRAME, .stage = SEND, .index = index, .actor = p->actor,
    .lease = frame->lease, .sequence = frame->stream_sequence,
    .geometry = frame->geometry_serial, .mutation = frame->snapshot_mutation,
    .screen = frame->screen,
    .metadata = resource.metadata
  };
  const char *error = NULL;
  /* resource is BORROWED: only the C held lease owns its source reference. */
  return send_message(&value, p->deadline) &&
    hvir_resource_send(address, peer, ticket, EDGE_MS, &resource, &error) && child_ack(p);
}
static bool cleanup_producer(producer *p) {
  if (!p->host) return true;
  p->stage = CLEANUP;
  if (p->actor) {
    hvir_terminal_result destroyed = hvir_terminal_destroy(p->host, p->actor);
    if (destroyed == HVIR_BUSY && p->held) {
      /* destroy returned only AFTER Surface teardown/join. This is actor-ended
       * cleanup, never a positive same-parser retirement fence. */
      if (!okay(p, hvir_terminal_release_frame(p->host, p->actor, p->held))) return false;
      p->held = 0;
      destroyed = hvir_terminal_destroy(p->host, p->actor);
    }
    if (!okay(p, destroyed)) return false;
    p->actor = 0;
  }
  if (!okay(p, hvir_terminal_close(p->host))) return false;
  p->host = NULL;
  return true;
}
static int child_main(const char *library, const char *address, const char *ticket,
                      int parent, unsigned scenario) {
  producer p = { .width = 640, .height = 320, .geometry = 1,
                 .deadline = now_ms() + CASE_MS, .stage = OPEN };
  uint64_t request = 0, duplicate = 0, original_lease = 0;
  uint32_t retirement = 0, rejected_status = 0;
  bool success = false;
  if (parent != getppid() || scenario >= CASES) return 2;
  if (!okay(&p, hvir_terminal_open(library, NULL, &p.host))) goto finished;
  if (scenario == STABLE) {
    tail.armed = true;
    tail.create = p.host->external_new;
    p.host->external_new = intercepted_surface;
  }
  p.stage = CREATE;
  if (!okay(&p, hvir_terminal_create_begin(p.host, p.width, p.height, &p.actor)))
    goto finished;
  p.stage = INITIAL_GEOMETRY;
  if (!applied(&p)) goto finished;
  hvir_terminal_frame original = {0};
  if (!stage_content(&p, 0) || !acquire(&p, 0, &original) ||
      !transfer(&p, &original, 0, address, ticket, parent)) goto finished;
  original_lease = p.held;
  if (scenario == RESIZE_OLD) { p.stage = RESIZE_BEFORE; if (!resize(&p)) goto finished; }
  if (scenario == HIDDEN_OLD) {
    p.stage = HIDE_BEFORE;
    if (!okay(&p, hvir_terminal_visibility(p.host, p.actor, 0))) goto finished;
  }
  p.stage = BEGIN;
  if (!okay(&p, hvir_terminal_retire_frame_begin(p.host, p.actor, p.held, &request)) ||
      !request ||
      !okay(&p, hvir_terminal_retire_frame_begin(p.host, p.actor, p.held, &duplicate)) ||
      request != duplicate) goto finished;
  if (hvir_terminal_retire_frame_status(p.host, p.actor, p.held, request + 1,
                                        &rejected_status) != HVIR_INVALID) goto finished;
  if (scenario == STABLE) {
    p.stage = CALLBACK_TAIL;
    const uint64_t barrier_deadline = bound(p.deadline, EDGE_MS);
    while (!tail_is_held() && now_ms() < barrier_deadline) pause_owner();
    if (!tail_is_held() ||
        !okay(&p, hvir_terminal_retire_frame_status(p.host, p.actor, p.held,
                                                    request, &retirement)) ||
        retirement != HVIR_FRAME_RETIRE_PENDING) goto finished;
    p.code = hvir_terminal_release_frame(p.host, p.actor, p.held);
    if (p.code != HVIR_BUSY) goto finished;
    const struct timespec interval = { .tv_nsec = 100000000 };
    (void)nanosleep(&interval, NULL);
    if (!tail_is_held() ||
        !okay(&p, hvir_terminal_retire_frame_status(p.host, p.actor, p.held,
                                                    request, &retirement)) ||
        retirement != HVIR_FRAME_RETIRE_PENDING) goto finished;
    const message held = {
      .kind = HELD_CALLBACK, .stage = CALLBACK_TAIL, .code = HVIR_BUSY,
      .actor = p.actor, .lease = p.held, .request = request, .retirement = retirement
    };
    if (!send_message(&held, p.deadline) || !child_ack(&p) || !release_tail()) goto finished;
  }
  if (scenario == ENDED) {
    p.stage = TEARDOWN;
    p.code = hvir_terminal_destroy(p.host, p.actor);
    if (p.code != HVIR_BUSY) goto finished;
  }
  p.stage = STATUS;
  const uint64_t deadline = bound(p.deadline, WAIT_MS);
  do {
    if (!okay(&p, hvir_terminal_retire_frame_status(p.host, p.actor, p.held,
                                                   request, &retirement))) goto finished;
    if (retirement != HVIR_FRAME_RETIRE_PENDING) break;
    pause_owner();
  } while (now_ms() < deadline);
  if (retirement != (scenario == ENDED ? HVIR_FRAME_RETIRE_ACTOR_ENDED
                                      : HVIR_FRAME_RETIRE_RETIRED)) {
    if (retirement == HVIR_FRAME_RETIRE_PENDING) p.code = HVIR_TIMEOUT;
    goto finished;
  }
  const message fence = {
    .kind = FENCE, .stage = STATUS, .actor = p.actor, .lease = p.held,
    .request = request, .retirement = retirement
  };
  if (!send_message(&fence, p.deadline) || !child_ack(&p)) goto finished;
  if (scenario == RESIZE_NEW) { p.stage = RESIZE_AFTER; if (!resize(&p)) goto finished; }
  if (scenario == HIDDEN_NEW) {
    p.stage = HIDE_AFTER;
    if (!okay(&p, hvir_terminal_visibility(p.host, p.actor, 0))) goto finished;
  }
  p.stage = SOURCE_RELEASE;
  /* Bind the next snapshot before rearming. Otherwise an eligible old-content
   * draw could consume a swap-chain slot between release and the next feed. */
  if (scenario != ENDED && !stage_content(&p, 1)) goto finished;
  if (!okay(&p, hvir_terminal_release_frame(p.host, p.actor, p.held))) goto finished;
  p.held = 0;
  if (scenario == ENDED) { success = true; goto finished; }
  if (scenario == HIDDEN_OLD || scenario == HIDDEN_NEW)
    if (!okay(&p, hvir_terminal_visibility(p.host, p.actor, 1))) goto finished;
  for (unsigned index = 1; index <= FRESH_FRAMES; index++) {
    p.stage = FRESH;
    hvir_terminal_frame frame = {0};
    if (!acquire(&p, index, &frame)) goto finished;
    p.stage = LATE_STATUS;
    if (hvir_terminal_retire_frame_status(p.host, p.actor, original_lease,
                                          request, &rejected_status) != HVIR_INVALID)
      goto finished;
    /* Only the latest released lease is idempotent; after B is released, oldA
     * is correctly INVALID. Either benign result must leave the exact current
     * lease available for transfer and its mandatory successful release below. */
    p.code = hvir_terminal_release_frame(p.host, p.actor, original_lease);
    if (p.code != HVIR_OK && p.code != HVIR_INVALID) goto finished;
    hvir_terminal_frame unexpected = {0};
    p.code = hvir_terminal_take_frame(p.host, p.actor, &unexpected);
    if (p.code != HVIR_BUSY) goto finished;
    if (!transfer(&p, &frame, index, address, ticket, parent)) goto finished;
    if (index < FRESH_FRAMES && !stage_content(&p, index + 1)) goto finished;
    if (!okay(&p, hvir_terminal_release_frame(p.host, p.actor, p.held))) goto finished;
    p.held = 0;
  }
  success = true;
finished:;
  const uint32_t failed_stage = p.stage;
  const hvir_terminal_result failed_code = p.code;
  /* Release only the probe's callback barrier before joining Surface teardown.
   * This never releases the C source lease or authorizes a pending fence. */
  (void)release_tail();
  const bool cleaned = cleanup_producer(&p);
  const message end = {
    .kind = success && cleaned ? COMPLETE : FAILURE,
    .stage = success && !cleaned ? CLEANUP : failed_stage,
    .code = success && !cleaned ? p.code : failed_code,
    .retirement = retirement, .request = request, .lease = original_lease
  };
  (void)send_message(&end, bound(p.deadline, EDGE_MS));
  return success && cleaned ? 0 : 1;
}

static bool metadata_equal(const hvir_resource_metadata *a, const hvir_resource_metadata *b) {
  if (a->kind != b->kind || a->width != b->width || a->height != b->height ||
      a->fourcc != b->fourcc || a->premultiplied != b->premultiplied ||
      a->color_space != b->color_space || a->origin != b->origin ||
      a->plane_count != b->plane_count || a->modifier != b->modifier) return false;
  for (unsigned n = 0; n < 4; n++)
    if (a->strides[n] != b->strides[n] || a->offsets[n] != b->offsets[n] ||
        a->sizes[n] != b->sizes[n]) return false;
  return true;
}
static bool hash_receipt(const hvir_resource_frame *frame, uint64_t *hash,
                         const uint8_t *expected, uint8_t *captured) {
#if defined(__APPLE__)
  if (frame->metadata.kind != 1 || !frame->surface || frame->metadata.plane_count ||
      frame->metadata.fourcc != 0x42475241u) return false;
  IOSurfaceRef surface = frame->surface;
  const size_t width = frame->metadata.width, height = frame->metadata.height;
  const size_t stride = IOSurfaceGetBytesPerRow(surface), allocation = IOSurfaceGetAllocSize(surface);
  if (!width || !height || width > 8192 || height > 8192 ||
      IOSurfaceGetWidth(surface) != width || IOSurfaceGetHeight(surface) != height ||
      IOSurfaceGetPixelFormat(surface) != frame->metadata.fourcc ||
      stride < width * 4 || stride > SIZE_MAX / height || stride * height > allocation ||
      IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return false;
  const uint8_t *pixels = IOSurfaceGetBaseAddress(surface);
  uint64_t value = UINT64_C(14695981039346656037);
  bool equal = true;
  if (pixels) {
    for (size_t row = 0; row < height; row++) {
      if (expected && memcmp(expected + row * width * 4, pixels + row * stride, width * 4)) {
        equal = false;
        break;
      }
      if (captured) memcpy(captured + row * width * 4, pixels + row * stride, width * 4);
      for (size_t column = 0; column < width * 4; column++)
        value = (value ^ pixels[row * stride + column]) * UINT64_C(1099511628211);
    }
  }
  const bool unlocked = IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL) == kIOReturnSuccess;
  if (!pixels || !unlocked || !equal) return false;
  *hash = value;
  return true;
#else
  (void)frame; (void)hash; (void)expected; (void)captured;
  return false;
#endif
}
static bool unchanged(result *r, const hvir_resource_frame *original, const uint8_t *baseline) {
  uint64_t current = 0;
  r->stage = PIXELS;
  if (!baseline || !hash_receipt(original, &current, baseline, NULL) ||
      current != r->original_hash) return false;
  r->unchanged_checks++;
  return true;
}
static bool reap(pid_t child, bool abort_child, int *exit_code) {
  int status = 0;
  uint64_t deadline = now_ms() + 2000;
  bool signalled = false;
  do {
    const pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) {
      *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      return true;
    }
    if (waited < 0 && errno != EINTR) return false;
    if (abort_child && !signalled) { (void)kill(-child, SIGTERM); signalled = true; }
    pause_owner();
  } while (now_ms() < deadline);
  (void)kill(-child, SIGKILL);
  deadline = now_ms() + 2000;
  do {
    const pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) {
      *exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      return true;
    }
    if (waited < 0 && errno != EINTR) return false;
    pause_owner();
  } while (now_ms() < deadline);
  return false;
}
static bool observed_cycle(const result *r) {
  return r->frames == FRESH_FRAMES && r->surfaces[1] && r->surfaces[2] &&
    r->surfaces[3] && r->surfaces[1] != r->surfaces[2] &&
    r->surfaces[1] != r->surfaces[3] && r->surfaces[2] != r->surfaces[3] &&
    r->surfaces[1] == r->surfaces[4] && r->surfaces[2] == r->surfaces[5] &&
    r->surfaces[3] == r->surfaces[6];
}
static const char *resource_failure(const char *error) {
  static const char *const allowed[] = {
    "endpoint-closed", "resource-timeout", "resource-receive-failed",
    "resource-message-rejected", "resource-peer-rejected", "resource-hello-rejected",
    "resource-frame-rejected", "resource-surface-lookup-failed", "resource-send-failed",
    "resource-kind-or-surface-invalid", "resource-surface-metadata-invalid",
    "resource-endpoint-create-failed", "resource-allocation-failed"
  };
  if (error)
    for (unsigned n = 0; n < sizeof(allowed) / sizeof(allowed[0]); n++)
      if (!strcmp(error, allowed[n])) return allowed[n];
  return "resource-error-unclassified";
}
static void print_progress(const result *r) {
  printf("{\"kind\":\"native-frame-retirement-progress\",\"case\":\"%s\","
    "\"stage\":\"%s\",\"producerPid\":%ld,\"authenticatedReceiptA\":%s,"
    "\"heldLease\":\"%" PRIu64 "\",\"request\":\"%" PRIu64 "\","
    "\"retirementStatus\":%u,\"freshFrames\":%u,\"retainedAUnchangedChecks\":%u}\n",
    names[r->index], r->stage < sizeof(stages) / sizeof(stages[0]) ? stages[r->stage] : "invalid",
    (long)r->producer_pid, r->receipt ? "true" : "false", r->lease, r->request,
    r->retirement, r->frames, r->unchanged_checks);
  fflush(stdout);
}
static void print_result(const result *r, bool passed) {
  printf("{\"kind\":\"native-frame-retirement-case\",\"case\":\"%s\","
    "\"passed\":%s,\"stage\":\"%s\",\"resultCode\":%u,\"failure\":\"%s\","
    "\"retirementStatus\":%u,\"actor\":\"%" PRIu64 "\","
    "\"heldLease\":\"%" PRIu64 "\",\"request\":\"%" PRIu64 "\",\"producerPid\":%ld,"
    "\"authenticatedReceiptA\":%s,\"freshFrames\":%u,"
    "\"retainedAUnchangedChecks\":%u,\"retainedAHash\":\"%016" PRIx64 "\","
    "\"retainedAPackedByteComparison\":%s,\"sourceA\":{\"width\":%u,\"height\":%u,"
    "\"geometry\":\"%" PRIu64 "\",\"sequence\":\"%" PRIu64 "\","
    "\"mutation\":\"%" PRIu64 "\",\"screen\":%u,\"kind\":%u,"
    "\"fourcc\":%u,\"colorSpace\":%u,\"origin\":%u,\"premultiplied\":%u},"
    "\"offeredFrame\":{\"index\":%u,\"lease\":\"%" PRIu64 "\","
    "\"sequence\":\"%" PRIu64 "\",\"geometry\":\"%" PRIu64 "\","
    "\"mutation\":\"%" PRIu64 "\",\"width\":%u,\"height\":%u,\"kind\":%u},"
    "\"joinedActorEnded\":%s,\"sameParserContinued\":%s,"
    "\"callbackTailHeld\":%s,\"pendingReleaseRefused\":%s,"
    "\"surfaceIds\":[%u,%u,%u,%u,%u,%u,%u],\"observedThreeTargetReuseCycle\":%s,"
    "\"childReaped\":%s,\"childExit\":%d,\"resourceCleanup\":%s}\n",
    names[r->index], passed ? "true" : "false",
    r->stage < sizeof(stages) / sizeof(stages[0]) ? stages[r->stage] : "invalid",
    r->code, passed ? "none" : r->failure ? r->failure : "probe-contract-failed",
    r->retirement, r->actor, r->lease, r->request, (long)r->producer_pid,
    r->receipt ? "true" : "false", r->frames, r->unchanged_checks, r->original_hash,
    r->unchanged_checks ? "true" : "false",
    r->original_source.metadata.width, r->original_source.metadata.height,
    r->original_source.geometry, r->original_source.sequence, r->original_source.mutation,
    r->original_source.screen, r->original_source.metadata.kind,
    r->original_source.metadata.fourcc, r->original_source.metadata.color_space,
    r->original_source.metadata.origin, r->original_source.metadata.premultiplied,
    r->offered_source.index, r->offered_source.lease, r->offered_source.sequence,
    r->offered_source.geometry, r->offered_source.mutation,
    r->offered_source.metadata.width, r->offered_source.metadata.height,
    r->offered_source.metadata.kind,
    r->retirement == HVIR_FRAME_RETIRE_ACTOR_ENDED ? "true" : "false",
    passed && r->index != ENDED ? "true" : "false",
    r->callback_tail_held ? "true" : "false", r->pending_release_refused ? "true" : "false",
    r->surfaces[0], r->surfaces[1], r->surfaces[2], r->surfaces[3],
    r->surfaces[4], r->surfaces[5], r->surfaces[6], observed_cycle(r) ? "true" : "false",
    r->child_reaped ? "true" : "false",
    r->child_exit, r->cleanup ? "true" : "false");
  fflush(stdout);
}
static bool parent_case(const char *executable, const char *library, unsigned scenario) {
  result r = { .index = scenario, .stage = START, .child_exit = -1 };
  hvir_resource_endpoint *endpoint = NULL;
  hvir_resource_frame original = {0}, current = {0};
  uint8_t *baseline = NULL;
  int to_child[2] = {-1, -1}, from_child[2] = {-1, -1};
  pid_t child = -1;
  bool passed = false;
  char address[HVIR_RESOURCE_ADDRESS_MAX], ticket[HVIR_RESOURCE_TICKET_MAX];
  char parent_text[24], scenario_text[8];
  (void)snprintf(address, sizeof(address), "org.hvir.retirement.%ld.%u.%" PRIu64,
                 (long)getpid(), scenario, now_ms());
  (void)snprintf(ticket, sizeof(ticket), "retire-%ld-%u-%" PRIu64,
                 (long)getpid(), scenario, now_ms());
  (void)snprintf(parent_text, sizeof(parent_text), "%ld", (long)getpid());
  (void)snprintf(scenario_text, sizeof(scenario_text), "%u", scenario);
  const char *error = NULL;
  if (!hvir_resource_endpoint_create(address, &endpoint, &error)) {
    r.failure = resource_failure(error);
    goto finished;
  }
  if (pipe(to_child) || pipe(from_child)) goto finished;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  int spawn_error = posix_spawn_file_actions_init(&actions);
  if (spawn_error) { r.code = (uint32_t)spawn_error; goto finished; }
  spawn_error = posix_spawnattr_init(&attributes);
  if (spawn_error) {
    posix_spawn_file_actions_destroy(&actions); r.code = (uint32_t)spawn_error; goto finished;
  }
  spawn_error = posix_spawn_file_actions_adddup2(&actions, to_child[0], STDIN_FILENO);
  if (!spawn_error) spawn_error = posix_spawn_file_actions_adddup2(&actions, from_child[1], STDOUT_FILENO);
  for (unsigned n = 0; n < 2 && !spawn_error; n++) {
    spawn_error = posix_spawn_file_actions_addclose(&actions, to_child[n]);
    if (!spawn_error) spawn_error = posix_spawn_file_actions_addclose(&actions, from_child[n]);
  }
  if (!spawn_error) spawn_error = posix_spawnattr_setpgroup(&attributes, 0);
  if (!spawn_error) spawn_error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
  char *const arguments[] = {
    (char *)executable, "--child", (char *)library, address, ticket, parent_text, scenario_text, NULL
  };
  if (!spawn_error) spawn_error = posix_spawn(&child, executable, &actions, &attributes, arguments, environ);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  if (spawn_error) { r.code = (uint32_t)spawn_error; goto finished; }
  r.producer_pid = child;
  print_progress(&r);
  close(to_child[0]); to_child[0] = -1;
  close(from_child[1]); from_child[1] = -1;
  const uint64_t deadline = now_ms() + CASE_MS;
  uint64_t hashes[FRESH_FRAMES + 1] = {0};
  while (now_ms() < deadline) {
    message value = {0};
    if (!pipe_io(from_child[0], &value, sizeof(value), false, deadline)) goto finished;
    r.stage = value.stage;
    r.code = value.code;
    if (value.kind == FAILURE) {
      r.retirement = value.retirement;
      r.request = value.request;
      goto finished;
    }
    if (value.kind == COMPLETE) {
      r.complete = true;
      passed = r.receipt && r.fence &&
        (scenario != STABLE || (r.callback_tail_held && r.pending_release_refused)) &&
        (scenario == ENDED ? r.frames == 0 : observed_cycle(&r));
      break;
    }
    if (value.kind == HELD_CALLBACK) {
      if (scenario != STABLE || !r.receipt || r.fence || r.callback_tail_held ||
          value.actor != r.actor || value.lease != r.lease || !value.request ||
          value.retirement != HVIR_FRAME_RETIRE_PENDING || value.code != HVIR_BUSY)
        goto finished;
      r.request = value.request;
      r.callback_tail_held = r.pending_release_refused = true;
      if (!unchanged(&r, &original, baseline)) goto finished;
    } else if (value.kind == FENCE) {
      if (!r.receipt || r.fence || value.actor != r.actor || value.lease != r.lease ||
          !value.request || (r.request && value.request != r.request) || value.retirement !=
            (scenario == ENDED ? HVIR_FRAME_RETIRE_ACTOR_ENDED : HVIR_FRAME_RETIRE_RETIRED))
        goto finished;
      r.retirement = value.retirement;
      r.request = value.request;
      r.fence = true;
      if (!unchanged(&r, &original, baseline)) goto finished;
    } else if (value.kind == FRAME) {
      r.stage = RECEIPT;
      r.offered_source = value;
      /* Feed provenance uses stream_sequence. With no input/appearance request,
       * snapshot_mutation legitimately remains0 and is checked against the
       * actual IO-applied mutation by the producer, never an invented serial. */
      if (value.index > FRESH_FRAMES || value.index != (r.receipt ? r.frames + 1 : 0) ||
          !value.actor || !value.lease || value.sequence != value.index + 1 ||
          !value.geometry ||
          (r.receipt && (!r.fence || value.actor != r.actor || value.lease <= r.lease))) {
        r.failure = "offered-source-provenance-invalid";
        goto finished;
      }
      if (!hvir_resource_receive(endpoint, child, ticket, EDGE_MS, &current, &error)) {
        r.failure = resource_failure(error);
        goto finished;
      }
      if (!metadata_equal(&value.metadata, &current.metadata)) {
        r.failure = "resource-metadata-mismatch";
        goto finished;
      }
      uint64_t hash = 0;
      r.stage = PIXELS;
      print_progress(&r);
      if (!r.receipt) {
        size_t bytes = 0;
        if (!hvir_terminal_packed_pixel_bytes(current.metadata.width,
                                               current.metadata.height, &bytes)) goto finished;
        baseline = malloc(bytes);
        if (!baseline) goto finished;
      }
      if (!hash_receipt(&current, &hash, NULL, r.receipt ? NULL : baseline)) goto finished;
#if defined(__APPLE__)
      r.surfaces[value.index] = IOSurfaceGetID(current.surface);
#endif
      if (!r.surfaces[value.index] ||
          (value.index && r.surfaces[value.index] == r.surfaces[0])) goto finished;
      for (unsigned n = 0; n < value.index; n++) if (hash == hashes[n]) goto finished;
      hashes[value.index] = hash;
      if (!r.receipt) {
        r.actor = value.actor; r.lease = value.lease;
        r.original_source = value;
        r.original_hash = hash;
        original = current;
        memset(&current, 0, sizeof(current));
        r.receipt = true;
      } else {
        r.frames++;
        if (!unchanged(&r, &original, baseline)) goto finished;
        hvir_resource_release(&current);
      }
    } else goto finished;
    print_progress(&r);
    uint32_t ack = 1;
    if (!pipe_io(to_child[1], &ack, sizeof(ack), true, deadline)) goto finished;
  }
finished:
  for (unsigned n = 0; n < 2; n++) {
    if (to_child[n] >= 0) close(to_child[n]);
    if (from_child[n] >= 0) close(from_child[n]);
  }
  if (child > 0) r.child_reaped = reap(child, !passed, &r.child_exit);
  if (!r.child_reaped || r.child_exit != 0) passed = false;
  const uint32_t original_stage = r.stage;
  const bool primary_failure = !passed;
  if (r.receipt && !unchanged(&r, &original, baseline)) passed = false;
  if (primary_failure) r.stage = original_stage;
  /* Never drop the independently owned A before the producer actually exits,
   * including failed/unknown fences. Outer process supervision contains a hung
   * unkillable child; no resource-cleanup success is fabricated in that case. */
  if (child <= 0 || r.child_reaped) {
    hvir_resource_release(&current);
    hvir_resource_release(&original);
    free(baseline);
    if (endpoint) { hvir_resource_endpoint_revoke(endpoint); hvir_resource_endpoint_free(endpoint); }
    r.cleanup = true;
  } else passed = false;
  print_result(&r, passed);
  return passed;
}

int main(int argc, char **argv) {
  (void)signal(SIGPIPE, SIG_IGN);
  if (argc == 7 && !strcmp(argv[1], "--child")) {
    char *end = NULL;
    const long parent = strtol(argv[5], &end, 10);
    if (!end || *end || parent <= 0 || parent > INT_MAX) return 2;
    const unsigned long scenario = strtoul(argv[6], &end, 10);
    if (!end || *end || scenario >= CASES) return 2;
    return child_main(argv[2], argv[3], argv[4], (int)parent, (unsigned)scenario);
  }
  if (argc != 2) {
    fputs("Usage: frame-retirement-probe LIBRARY\n", stderr);
    return 2;
  }
#if !defined(__APPLE__)
  (void)parent_case;
  puts("{\"kind\":\"native-frame-retirement\",\"passed\":false,"
       "\"unsupported\":\"real-dma-buf-pixel-witness-not-implemented\","
       "\"linuxHardwareQualified\":false}");
  return 2;
#else
  char executable[PATH_MAX];
  if (!realpath(argv[0], executable)) return 2;
  for (unsigned scenario = 0; scenario < CASES; scenario++)
    if (!parent_case(executable, argv[1], scenario)) return 1;
  puts("{\"kind\":\"native-frame-retirement\",\"passed\":true,\"cases\":6,"
       "\"freshFramesPerLiveCase\":6,\"realIOSurfaceTransport\":true,"
       "\"linuxHardwareQualified\":false,\"physicalOcclusionQualified\":false,"
       "\"callbackTailBarrierExercised\":true,\"failedFenceInjected\":false,"
       "\"customShaderAliasesQualified\":false,\"targetAllocationGenerationObserved\":false,"
       "\"productionRecoveryQualified\":false,\"consumerReadCompletionQualified\":false,"
       "\"qualificationPixelReadback\":true}");
  return 0;
#endif
}
