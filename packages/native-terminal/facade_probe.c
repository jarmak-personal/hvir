#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "terminal.h"
#include "ghostty.h"
#include <dirent.h>
#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <IOSurface/IOSurface.h>
#include <libproc.h>
#include <sys/proc_info.h>
#elif defined(__linux__)
#include <fcntl.h>
#endif

/* Real native-owner proof, not Electron presentation, SSH, or hardware qualification.
 * Only the worker owns facade operations; main makes two intentional wrong-thread calls.
 * Diagnostics contain fixed contract names/counts, never terminal text or input bytes. */
typedef struct {
  const char *library;
  bool frames;
  pthread_t main_thread;
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  bool ready, inspected, finished;
  hvir_terminal_host *host;
  hvir_terminal_id first;
  hvir_terminal_result wrong_inspect, wrong_feed;
  unsigned checks, frame_kind;
  bool frame_hashed, os_children_checked, os_ptys_checked;
  int result;
} probe;

static uint64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
  return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static void yield_owner(void) {
  const struct timespec interval = { .tv_nsec = 1000000 };
  nanosleep(&interval, NULL);
}

static bool check(probe *p, bool value, const char *contract) {
  p->checks++;
  if (value) return true;
  fprintf(stderr, "native-facade-probe: contract failed: %s\n", contract);
  return false;
}

static bool stale(hvir_terminal_result result) {
  return result == HVIR_INVALID || result == HVIR_CLOSED;
}

static bool text_is(hvir_terminal_host *host, hvir_terminal_id id, const char *expected) {
  uint8_t *text = malloc(HVIR_TERMINAL_TEXT_MAX);
  if (!text) return false;
  size_t length = 0;
  const hvir_terminal_result result = hvir_terminal_read(
    host, id, text, HVIR_TERMINAL_TEXT_MAX, &length);
  if (result != HVIR_OK || length > HVIR_TERMINAL_TEXT_MAX) {
    free(text);
    return false;
  }
  /* Full-screen plain formatting may include a final line ending. Do not normalize
   * embedded newlines, Unicode, spaces, or any other content. Exact tail semantics
   * for authenticated extraction belong to the retained-state query child. */
  while (length && (text[length - 1] == '\r' || text[length - 1] == '\n')) length--;
  const bool equal = result == HVIR_OK && length == strlen(expected) &&
    memcmp(text, expected, length) == 0;
  free(text);
  return equal;
}

static bool feed(hvir_terminal_host *host, hvir_terminal_id id,
                 uint64_t *sequence, const void *bytes, size_t length) {
  const hvir_terminal_result result = hvir_terminal_feed(
    host, id, *sequence + 1, bytes, length);
  if (result != HVIR_OK) return false;
  (*sequence)++;
  return true;
}

static bool geometry(hvir_terminal_host *host, hvir_terminal_id id,
                     uint64_t serial, uint32_t width, uint32_t height,
                     hvir_terminal_status *status) {
  const uint64_t deadline = now_ms() + 10000;
  do {
    if (hvir_terminal_inspect(host, id, status) != HVIR_OK || status->failure)
      return false;
    if (status->geometry.serial == serial) {
      const bool applied = status->geometry.width == width &&
        status->geometry.height == height && status->geometry.columns > 0 &&
        status->geometry.rows > 0;
      if (!applied) fprintf(stderr, "native-facade-probe: geometry serial=%" PRIu64
        " pixels=%ux%u cells=%ux%u\n", serial, status->geometry.width,
        status->geometry.height, status->geometry.columns, status->geometry.rows);
      return applied;
    }
    if (status->geometry.serial > serial) return false;
    yield_owner();
  } while (now_ms() < deadline);
  return false;
}

static bool reply_count(hvir_terminal_host *host, hvir_terminal_id id,
                        size_t expected, hvir_terminal_status *status) {
  const uint64_t deadline = now_ms() + 10000;
  do {
    if (hvir_terminal_inspect(host, id, status) != HVIR_OK || status->failure)
      return false;
    if (status->queued_reply_bytes == expected) return true;
    if (status->queued_reply_bytes > expected) return false;
    yield_owner();
  } while (now_ms() < deadline);
  return false;
}

static bool drain_is(hvir_terminal_host *host, hvir_terminal_id id,
                     const uint8_t *expected, size_t length) {
  uint8_t bytes[127];
  size_t offset = 0;
  while (offset < length) {
    size_t written = 0;
    if (hvir_terminal_drain(host, id, bytes, sizeof(bytes), &written) != HVIR_OK ||
        !written || written > sizeof(bytes) || written > length - offset ||
        memcmp(bytes, expected + offset, written)) return false;
    offset += written;
  }
  size_t written = 0;
  return hvir_terminal_drain(host, id, bytes, sizeof(bytes), &written) == HVIR_OK &&
    written == 0;
}

static int child_count(void) {
#if defined(__APPLE__)
  pid_t children[1024];
  const int bytes = proc_listchildpids(getpid(), children, sizeof(children));
  if (bytes < 0 || bytes >= (int)sizeof(children)) return -1;
  return bytes / (int)sizeof(pid_t);
#elif defined(__linux__)
  /* Linux children are task-scoped: include threads which could have forked. */
  DIR *tasks = opendir("/proc/self/task");
  if (!tasks) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(tasks))) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char path[512];
    if (snprintf(path, sizeof(path), "/proc/self/task/%s/children", entry->d_name)
        >= (int)sizeof(path)) { count = -1; break; }
    FILE *file = fopen(path, "r");
    if (!file) { if (errno == ENOENT) continue; count = -1; break; }
    long child;
    while (fscanf(file, "%ld", &child) == 1) count++;
    fclose(file);
  }
  closedir(tasks);
  return count;
#else
  return -1;
#endif
}

static bool pty_path(const char *path) {
  return !strncmp(path, "/dev/pts/", 9) || !strcmp(path, "/dev/ptmx") ||
    !strncmp(path, "/dev/ttys", 9) || !strncmp(path, "/dev/ptys", 9);
}

static int pty_count(void) {
#if defined(__APPLE__)
  struct proc_fdinfo files[4096];
  const int bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, files, sizeof(files));
  if (bytes <= 0 || bytes >= (int)sizeof(files)) return -1;
  int count = 0;
  for (int i = 0; i < bytes / (int)sizeof(files[0]); i++) {
    if (files[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    struct vnode_fdinfowithpath value;
    const int size = proc_pidfdinfo(getpid(), files[i].proc_fd,
      PROC_PIDFDVNODEPATHINFO, &value, sizeof(value));
    if (size == (int)sizeof(value) && pty_path(value.pvip.vip_path)) count++;
  }
  return count;
#elif defined(__linux__)
  DIR *files = opendir("/proc/self/fd");
  if (!files) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(files))) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char path[512], target[4096];
    if (snprintf(path, sizeof(path), "/proc/self/fd/%s", entry->d_name)
        >= (int)sizeof(path)) { count = -1; break; }
    const ssize_t size = readlink(path, target, sizeof(target) - 1);
    if (size < 0) { if (errno == ENOENT) continue; count = -1; break; }
    target[size] = 0;
    if (pty_path(target)) count++;
  }
  closedir(files);
  return count;
#else
  return -1;
#endif
}

static uint64_t hash_bytes(const uint8_t *bytes, size_t length) {
  uint64_t hash = UINT64_C(14695981039346656037);
  for (size_t i = 0; i < length; i++) hash = (hash ^ bytes[i]) * UINT64_C(1099511628211);
  return hash;
}

static bool frame_hash(const hvir_terminal_frame *frame, uint64_t *hash) {
  if (frame->kind == 3 && frame->pixels && frame->pixel_bytes) {
    *hash = hash_bytes(frame->pixels, frame->pixel_bytes);
    return true;
  }
#if defined(__APPLE__)
  if (frame->kind == 1 && frame->surface) {
    IOSurfaceRef surface = (IOSurfaceRef)frame->surface;
    if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL)) return false;
    const uint8_t *pixels = IOSurfaceGetBaseAddress(surface);
    const size_t size = IOSurfaceGetAllocSize(surface);
    if (pixels && size) *hash = hash_bytes(pixels, size);
    const bool valid = pixels && size;
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    return valid;
  }
#endif
  return false;
}

static bool frame_valid(const hvir_terminal_frame *frame) {
  if (!frame->lease || !frame->width || !frame->height) return false;
  if (frame->kind == 1) return frame->surface != NULL;
  if (frame->kind == 3)
    return frame->pixels && frame->pixel_bytes >= (uint64_t)frame->width * frame->height * 4;
  if (frame->kind != 2 || !frame->plane_count || frame->plane_count > 4) return false;
  for (uint32_t i = 0; i < frame->plane_count; i++) {
    if (frame->fds[i] < 0 || !frame->strides[i]) return false;
#if defined(__linux__)
    if (fcntl(frame->fds[i], F_GETFD) < 0) return false;
#endif
  }
  return true;
}

#define REQUIRE(value, name) do { if (!check(p, (value), (name))) goto cleanup; } while (0)

static void *run_probe(void *context) {
  probe *p = context;
  hvir_terminal_host *host = NULL;
  hvir_terminal_id a = 0, b = 0, replacement = 0, events = 0, large = 0;
  uint64_t sequence_a = 0, sequence_b = 0, sequence_replacement = 0;
  hvir_terminal_status status = {0};
  hvir_terminal_frame held = {0};
  uint8_t *requests = NULL, *expected = NULL;
  const int initial_ptys = pty_count(), initial_children = child_count();
  p->os_children_checked = initial_children >= 0;
  p->os_ptys_checked = initial_ptys >= 0;
  p->result = 1;
  REQUIRE(!pthread_equal(pthread_self(), p->main_thread), "native-owner-thread");
  REQUIRE(initial_children <= 0, "no-initial-children");
  REQUIRE(hvir_terminal_open(p->library, NULL, &host) == HVIR_OK && host,
          "open-on-worker");
  REQUIRE(hvir_terminal_create(host, 1000, 600, &a) == HVIR_OK && a,
          "create-first-state");
  REQUIRE(hvir_terminal_create(host, 1000, 600, &b) == HVIR_OK && b && a != b,
          "create-independent-state");
  REQUIRE(geometry(host, a, 1, 1000, 600, &status), "initial-applied-geometry");
  REQUIRE(status.applied_sequence == 0 && !status.failure, "initial-stream-state");
  REQUIRE(hvir_terminal_close(host) == HVIR_BUSY, "live-state-prevents-host-close");

  pthread_mutex_lock(&p->mutex);
  p->host = host;
  p->first = a;
  p->ready = true;
  pthread_cond_signal(&p->condition);
  while (!p->inspected) pthread_cond_wait(&p->condition, &p->mutex);
  pthread_mutex_unlock(&p->mutex);
  REQUIRE(p->wrong_inspect == HVIR_WRONG_THREAD && p->wrong_feed == HVIR_WRONG_THREAD,
          "wrong-thread-rejection");
  REQUIRE(hvir_terminal_inspect(host, a, &status) == HVIR_OK &&
          status.applied_sequence == 0 && text_is(host, a, ""),
          "wrong-thread-has-no-effect");

  REQUIRE(feed(host, a, &sequence_a, "alpha:", 6), "feed-first-prefix");
  const uint8_t utf8_head[] = {0xf0, 0x9f}, utf8_tail[] = {0x99, 0x82};
  REQUIRE(feed(host, a, &sequence_a, utf8_head, sizeof(utf8_head)), "feed-split-utf8-head");
  REQUIRE(feed(host, a, &sequence_a, utf8_tail, sizeof(utf8_tail)), "feed-split-utf8-tail");
  REQUIRE(feed(host, a, &sequence_a, "\x1b[", 2), "feed-split-csi-head");
  const char suffix[] = "31mred\x1b[0m\r\nrow2";
  REQUIRE(feed(host, a, &sequence_a, suffix, sizeof(suffix) - 1), "feed-split-csi-tail");
  REQUIRE(feed(host, b, &sequence_b, "beta-only", 9), "feed-independent-state");
  const char normal[] = "alpha:\xf0\x9f\x99\x82red\nrow2";
  REQUIRE(text_is(host, a, normal) && text_is(host, b, "beta-only"),
          "exact-text-and-state-isolation");

  const char alternate[] = "\x1b[?1049h\x1b[Halternate";
  REQUIRE(feed(host, a, &sequence_a, alternate, sizeof(alternate) - 1) &&
          text_is(host, a, "alternate"), "alternate-screen-text");
  REQUIRE(feed(host, a, &sequence_a, "\x1b[?1049l", 8) && text_is(host, a, normal),
          "restore-normal-screen");
  REQUIRE(text_is(host, b, "beta-only"), "alternate-screen-isolation");

  uint8_t key[128];
  size_t written = 0;
  const char key_text[] = "\xc3\xa9\xf0\x9f\x99\x82";
  REQUIRE(hvir_terminal_key(host, a, GHOSTTY_KEY_UNIDENTIFIED, 0,
          GHOSTTY_ACTION_PRESS, key_text, key, sizeof(key), &written) == HVIR_OK &&
          written == sizeof(key_text) - 1 && !memcmp(key, key_text, written),
          "raw-utf8-key-bytes");
  REQUIRE(hvir_terminal_key(host, a, GHOSTTY_KEY_SPACE, GHOSTTY_MODS_CTRL,
          GHOSTTY_ACTION_PRESS, " ", key, sizeof(key), &written) == HVIR_OK &&
          written == 1 && key[0] == 0, "encoded-nul-key-byte");
  REQUIRE(drain_is(host, a, NULL, 0) && drain_is(host, b, NULL, 0),
          "key-output-not-duplicated-as-reply");

  REQUIRE(hvir_terminal_feed(host, a, sequence_a, (const uint8_t *)"x", 1) ==
          HVIR_INVALID, "duplicate-sequence-rejection");
  REQUIRE(hvir_terminal_feed(host, a, sequence_a + 2, (const uint8_t *)"x", 1) ==
          HVIR_INVALID, "out-of-order-sequence-rejection");
  requests = calloc(HVIR_TERMINAL_FEED_MAX + 1, 1);
  REQUIRE(requests, "allocate-bounded-feed-fixture");
  REQUIRE(hvir_terminal_feed(host, a, sequence_a + 1, requests,
          HVIR_TERMINAL_FEED_MAX + 1) == HVIR_BOUND, "feed-bound-rejection");
  free(requests); requests = NULL;
  REQUIRE(hvir_terminal_inspect(host, a, &status) == HVIR_OK &&
          status.applied_sequence == sequence_a && !status.failure &&
          text_is(host, a, normal), "rejected-feed-has-no-effect");

  REQUIRE(hvir_terminal_resize(host, a, 2, 1000, 600) == HVIR_OK &&
          geometry(host, a, 2, 1000, 600, &status), "same-size-serial-two");
  REQUIRE(hvir_terminal_resize(host, a, 3, 1000, 600) == HVIR_OK &&
          geometry(host, a, 3, 1000, 600, &status), "same-size-serial-three");
  REQUIRE(hvir_terminal_resize(host, a, 4, 700, 400) == HVIR_OK &&
          hvir_terminal_resize(host, a, 5, 900, 500) == HVIR_OK &&
          geometry(host, a, 5, 900, 500, &status), "latest-applied-resize");
  REQUIRE(hvir_terminal_resize(host, a, 4, 600, 300) == HVIR_INVALID &&
          hvir_terminal_resize(host, a, 5, 600, 300) == HVIR_INVALID,
          "stale-geometry-serial-rejection");
  char size_reply[80];
  const int reply_size = snprintf(size_reply, sizeof(size_reply), "\x1b[8;%u;%ut",
    status.geometry.rows, status.geometry.columns);
  REQUIRE(reply_size > 0 && reply_size < (int)sizeof(size_reply) &&
          feed(host, a, &sequence_a, "\x1b[18t", 5) &&
          reply_count(host, a, (size_t)reply_size, &status) &&
          drain_is(host, a, (const uint8_t *)size_reply, (size_t)reply_size),
          "parser-reports-applied-geometry");

  if (p->frames) {
    const uint64_t deadline = now_ms() + 10000;
    hvir_terminal_result result;
    do {
      REQUIRE(hvir_terminal_inspect(host, a, &status) == HVIR_OK && !status.failure,
              "frame-progress-inspection");
      result = hvir_terminal_take_frame(host, a, &held);
      if (result == HVIR_OK && held.geometry_serial < 5) {
        REQUIRE(hvir_terminal_release_frame(host, a, held.lease) == HVIR_OK,
                "release-earlier-completed-frame");
        memset(&held, 0, sizeof(held));
        result = HVIR_BUSY;
      }
      if (result != HVIR_BUSY) break;
      yield_owner();
    } while (now_ms() < deadline);
    REQUIRE(result == HVIR_OK || result == HVIR_UNSUPPORTED, "explicit-frame-capability");
    if (result == HVIR_OK) {
      p->frame_kind = held.kind;
      REQUIRE(frame_valid(&held) && held.geometry_serial == 5 &&
              held.stream_sequence <= sequence_a, "completed-frame-metadata");
      uint64_t before = 0, after = 0;
      p->frame_hashed = frame_hash(&held, &before);
      if (held.kind == 1 || held.kind == 3)
        REQUIRE(p->frame_hashed, "readable-frame-pixels");
      const uint64_t first_lease = held.lease;
      REQUIRE(hvir_terminal_release_frame(host, a, first_lease) == HVIR_OK,
              "release-first-live-frame");
      memset(&held, 0, sizeof(held));
      const char repaint[] = "\x1b[44m\x1b[2J\x1b[Hreleased-frame-repaint";
      REQUIRE(feed(host, a, &sequence_a, repaint, sizeof(repaint) - 1),
              "feed-visible-update-after-release");
      const uint64_t repaint_deadline = now_ms() + 10000;
      do {
        REQUIRE(hvir_terminal_inspect(host, a, &status) == HVIR_OK && !status.failure,
                "released-frame-render-progress");
        result = hvir_terminal_take_frame(host, a, &held);
        if (result == HVIR_OK && (held.geometry_serial != 5 ||
                                 held.stream_sequence != sequence_a)) {
          REQUIRE(hvir_terminal_release_frame(host, a, held.lease) == HVIR_OK,
                  "release-frame-before-repaint-applied");
          memset(&held, 0, sizeof(held));
          result = HVIR_BUSY;
        }
        if (result != HVIR_BUSY) break;
        yield_owner();
      } while (now_ms() < repaint_deadline);
      REQUIRE(result == HVIR_OK && frame_valid(&held) && held.lease > first_lease &&
              held.geometry_serial == status.geometry.serial &&
              held.stream_sequence == status.applied_sequence &&
              text_is(host, a, "released-frame-repaint"),
              "release-resumes-rendering-on-same-live-state");
      if (p->frame_hashed) {
        REQUIRE(frame_hash(&held, &after) && before != after,
                "released-frame-update-changes-pixels");
        before = after;
      }
      const char marker[] = "\x1b[H\x1b[2Jheld-frame-progress";
      REQUIRE(feed(host, a, &sequence_a, marker, sizeof(marker) - 1) &&
              hvir_terminal_resize(host, a, 6, 800, 450) == HVIR_OK &&
              geometry(host, a, 6, 800, 450, &status) &&
              text_is(host, a, "held-frame-progress"), "held-frame-does-not-block-state");
      REQUIRE(frame_valid(&held), "held-frame-resource-still-live");
      if (p->frame_hashed)
        REQUIRE(frame_hash(&held, &after) && before == after, "held-frame-pixels-immutable");
      const uint64_t lease = held.lease;
      REQUIRE(stale(hvir_terminal_release_frame(host, b, lease)),
              "foreign-state-cannot-release-frame");
      REQUIRE(hvir_terminal_destroy(host, a) == HVIR_BUSY &&
              hvir_terminal_inspect(host, a, &status) == HVIR_OK && status.closing,
              "held-frame-defers-destruction-and-revokes-admission");
      REQUIRE(frame_valid(&held), "retired-engine-frame-resource-still-live");
      if (p->frame_hashed)
        REQUIRE(frame_hash(&held, &after) && before == after,
                "retired-engine-frame-pixels-immutable");
      REQUIRE(hvir_terminal_feed(host, a, sequence_a + 1,
              (const uint8_t *)"revoked", 7) == HVIR_CLOSED,
              "retiring-state-refuses-output");
      REQUIRE(hvir_terminal_release_frame(host, a, lease) == HVIR_OK,
              "release-held-frame");
      memset(&held, 0, sizeof(held));
      REQUIRE(hvir_terminal_release_frame(host, a, lease) == HVIR_OK,
              "duplicate-frame-release-is-idempotent");
      REQUIRE(hvir_terminal_destroy(host, a) == HVIR_OK,
              "destroy-after-held-frame-release");
      a = 0;
      REQUIRE(hvir_terminal_create(host, 1000, 600, &a) == HVIR_OK,
              "create-state-after-frame-retirement");
      sequence_a = 0;
    }
  }

  REQUIRE(feed(host, a, &sequence_a, "\x1b[H", 3), "position-cursor-for-report-burst");
  requests = malloc(256 * 4); expected = malloc(256 * 6);
  REQUIRE(requests && expected, "allocate-report-burst-fixture");
  for (size_t i = 0; i < 256; i++) {
    memcpy(requests + i * 4, "\x1b[6n", 4);
    memcpy(expected + i * 6, "\x1b[1;1R", 6);
  }
  REQUIRE(feed(host, a, &sequence_a, requests, 256 * 4) &&
          reply_count(host, a, 256 * 6, &status) &&
          drain_is(host, a, expected, 256 * 6), "ordered-more-than-64-reports");
  REQUIRE(drain_is(host, b, NULL, 0) && text_is(host, b, "beta-only"),
          "report-burst-route-isolation");
  free(requests); requests = NULL; free(expected); expected = NULL;

  REQUIRE(hvir_terminal_create(host, 1000, 600, &large) == HVIR_OK,
          "create-large-output-state");
  requests = malloc(5000 * 96);
  expected = malloc(5000 * 64);
  REQUIRE(requests && expected, "allocate-large-ordered-output-fixture");
  size_t large_bytes = 0, plain_bytes = 0;
  for (unsigned i = 0; i < 5000; i++) {
    const char *ending = i == 4999 ? "" : "\r\n";
    const int encoded = snprintf((char *)requests + large_bytes,
      5000 * 96 - large_bytes, "\x1b[3%umrow-%04u \xc3\xa9\xf0\x9f\x99\x82 payload\x1b[0m%s",
      i % 8, i, ending);
    const int plain = snprintf((char *)expected + plain_bytes,
      5000 * 64 - plain_bytes, "row-%04u \xc3\xa9\xf0\x9f\x99\x82 payload%s",
      i, i == 4999 ? "" : "\n");
    REQUIRE(encoded > 0 && encoded < 96 && plain > 0 && plain < 64,
            "bounded-large-output-line");
    large_bytes += (size_t)encoded;
    plain_bytes += (size_t)plain;
  }
  uint64_t large_sequence = 0;
  for (size_t offset = 0; offset < large_bytes;) {
    const size_t remaining = large_bytes - offset;
    const size_t chunk = remaining < 4093 ? remaining : 4093;
    REQUIRE(feed(host, large, &large_sequence, requests + offset, chunk),
            "ordered-large-output-chunk");
    offset += chunk;
  }
  REQUIRE(plain_bytes < HVIR_TERMINAL_TEXT_MAX && text_is(host, large, (char *)expected) &&
          hvir_terminal_inspect(host, large, &status) == HVIR_OK &&
          status.applied_sequence == large_sequence && !status.failure,
          "exact-5000-line-retained-output");
  REQUIRE(text_is(host, b, "beta-only") && drain_is(host, b, NULL, 0),
          "large-output-state-isolation");
  REQUIRE(hvir_terminal_destroy(host, large) == HVIR_OK, "destroy-large-output-state");
  large = 0;
  free(requests); requests = NULL; free(expected); expected = NULL;

  REQUIRE(hvir_terminal_create(host, 1000, 600, &large) == HVIR_OK,
          "create-synchronized-output-state");
  uint64_t synchronized_sequence = 0;
  const char synchronized[] = "\x1b[?2026hsynchronized-output";
  REQUIRE(feed(host, large, &synchronized_sequence, synchronized,
               sizeof(synchronized) - 1) &&
          text_is(host, large, "synchronized-output") &&
          hvir_terminal_inspect(host, large, &status) == HVIR_OK &&
          status.applied_sequence == synchronized_sequence && !status.failure,
          "synchronized-output-does-not-block-feed-or-readback");
  if (p->frames && p->frame_kind) {
    const uint64_t sync_deadline = now_ms() + 100;
    do {
      REQUIRE(hvir_terminal_inspect(host, large, &status) == HVIR_OK && !status.failure,
              "synchronized-frame-progress");
      hvir_terminal_frame frame = {0};
      const hvir_terminal_result result = hvir_terminal_take_frame(host, large, &frame);
      if (result == HVIR_OK) {
        const bool earlier = frame.stream_sequence < synchronized_sequence;
        REQUIRE(hvir_terminal_release_frame(host, large, frame.lease) == HVIR_OK,
                "release-pre-synchronization-frame");
        REQUIRE(earlier, "synchronized-output-does-not-publish-uncommitted-frame");
      } else REQUIRE(result == HVIR_BUSY, "synchronized-frame-capability-stays-valid");
      yield_owner();
    } while (now_ms() < sync_deadline);
  }
  const char synchronized_end[] = "-continued\x1b[?2026l";
  REQUIRE(feed(host, large, &synchronized_sequence, synchronized_end,
               sizeof(synchronized_end) - 1) &&
          text_is(host, large, "synchronized-output-continued"),
          "synchronized-output-end-preserves-ordered-state");
  if (p->frames && p->frame_kind) {
    const uint64_t committed_deadline = now_ms() + 10000;
    bool completed = false;
    do {
      REQUIRE(hvir_terminal_inspect(host, large, &status) == HVIR_OK && !status.failure,
              "committed-synchronized-frame-progress");
      hvir_terminal_frame frame = {0};
      const hvir_terminal_result result = hvir_terminal_take_frame(host, large, &frame);
      if (result == HVIR_OK) {
        completed = frame_valid(&frame) && frame.stream_sequence == synchronized_sequence &&
          frame.geometry_serial == status.geometry.serial &&
          frame.width == status.geometry.width && frame.height == status.geometry.height;
        const bool not_future = frame.stream_sequence <= synchronized_sequence;
        REQUIRE(hvir_terminal_release_frame(host, large, frame.lease) == HVIR_OK,
                "release-committed-synchronized-frame");
        REQUIRE(not_future, "synchronized-frame-never-claims-future-input");
        if (completed) break;
      } else REQUIRE(result == HVIR_BUSY, "committed-frame-capability-stays-valid");
      yield_owner();
    } while (now_ms() < committed_deadline);
    REQUIRE(completed, "synchronized-output-unset-publishes-exact-latest-sequence");
  }
  REQUIRE(hvir_terminal_resize(host, large, 2, 700, 400) == HVIR_OK &&
          hvir_terminal_destroy(host, large) == HVIR_OK,
          "destroy-state-immediately-after-pending-resize");
  const hvir_terminal_id resized_then_destroyed = large;
  large = 0;
  REQUIRE(stale(hvir_terminal_inspect(host, resized_then_destroyed, &status)) &&
          text_is(host, b, "beta-only"), "pending-resize-cannot-revive-destroyed-state");

  REQUIRE(hvir_terminal_create(host, 1000, 600, &events) == HVIR_OK,
          "create-metadata-state");
  requests = malloc(200 * 32);
  REQUIRE(requests, "allocate-metadata-burst-fixture");
  size_t request_length = 0;
  for (unsigned i = 0; i < 80; i++) {
    const int size = snprintf((char *)requests + request_length,
      200 * 32 - request_length, "\x1b]2;title-%03u\x07", i);
    REQUIRE(size > 0 && size < 32, "bounded-title-fixture");
    request_length += (size_t)size;
  }
  REQUIRE(hvir_terminal_feed(host, events, 1, requests, request_length) == HVIR_OK,
          "feed-more-than-64-metadata-events");
  for (unsigned i = 0; i < 80; i++) {
    hvir_terminal_event event;
    char title[32];
    const int length = snprintf(title, sizeof(title), "title-%03u", i);
    REQUIRE(hvir_terminal_next_event(host, events, &event) == HVIR_OK &&
            event.kind == 1 && event.length == (size_t)length &&
            !memcmp(event.data, title, (size_t)length), "ordered-copied-title-event");
  }
  hvir_terminal_event event;
  REQUIRE(hvir_terminal_next_event(host, events, &event) == HVIR_BUSY &&
          hvir_terminal_next_event(host, b, &event) == HVIR_BUSY,
          "metadata-drain-and-route-isolation");
  request_length = 0;
  for (unsigned i = 0; i < 200; i++) {
    const char title[] = "\x1b]2;saturated\x07";
    memcpy(requests + request_length, title, sizeof(title) - 1);
    request_length += sizeof(title) - 1;
  }
  const hvir_terminal_result metadata_result = hvir_terminal_feed(
    host, events, 2, requests, request_length);
  REQUIRE(metadata_result == HVIR_OK || metadata_result == HVIR_BOUND ||
          metadata_result == HVIR_FAILED, "metadata-saturation-explicit-outcome");
  REQUIRE(hvir_terminal_inspect(host, events, &status) == HVIR_OK && status.failure,
          "metadata-saturation-visible-failure");
  REQUIRE(hvir_terminal_destroy(host, events) == HVIR_OK,
          "destroy-metadata-saturated-state");
  events = 0;
  free(requests); requests = NULL;

  if (p->os_children_checked) REQUIRE(child_count() == 0, "no-native-child-process");
  if (p->os_ptys_checked) REQUIRE(pty_count() == initial_ptys, "no-native-pty");
  REQUIRE(hvir_terminal_destroy(host, a) == HVIR_OK, "destroy-first-state");
  const hvir_terminal_id old = a; a = 0;
  REQUIRE(hvir_terminal_create(host, 1000, 600, &replacement) == HVIR_OK &&
          replacement != old, "replacement-has-fresh-identity");
  REQUIRE(stale(hvir_terminal_inspect(host, old, &status)) &&
          stale(hvir_terminal_feed(host, old, 1, (const uint8_t *)"stale", 5)) &&
          text_is(host, replacement, ""), "destroyed-handle-cannot-target-replacement");

  requests = malloc(12000 * 4);
  REQUIRE(requests, "allocate-reply-saturation-fixture");
  for (size_t i = 0; i < 12000; i++) memcpy(requests + i * 4, "\x1b[6n", 4);
  const hvir_terminal_result saturated = hvir_terminal_feed(
    host, replacement, ++sequence_replacement, requests, 12000 * 4);
  REQUIRE(saturated == HVIR_OK || saturated == HVIR_BOUND || saturated == HVIR_FAILED,
          "reply-saturation-explicit-feed-outcome");
  const uint64_t saturation_deadline = now_ms() + 10000;
  do {
    REQUIRE(hvir_terminal_inspect(host, replacement, &status) == HVIR_OK,
            "failed-state-remains-inspectable");
    if (status.failure) break;
    yield_owner();
  } while (now_ms() < saturation_deadline);
  REQUIRE(status.failure && status.queued_reply_bytes <= HVIR_TERMINAL_REPLY_MAX,
          "reply-saturation-bounded-visible-failure");
  REQUIRE(hvir_terminal_feed(host, replacement, sequence_replacement + 1,
          (const uint8_t *)"late", 4) == HVIR_FAILED,
          "failed-state-refuses-further-output");
  REQUIRE(text_is(host, b, "beta-only"), "saturation-isolated-from-other-state");
  REQUIRE(hvir_terminal_destroy(host, replacement) == HVIR_OK,
          "destroy-reply-saturated-state");
  replacement = 0;
  REQUIRE(hvir_terminal_destroy(host, b) == HVIR_OK, "destroy-second-state"); b = 0;
  REQUIRE(hvir_terminal_close(host) == HVIR_OK, "close-after-reply-saturation"); host = NULL;
  if (p->os_children_checked) REQUIRE(child_count() == 0, "no-child-after-close");
  if (p->os_ptys_checked) REQUIRE(pty_count() == initial_ptys, "no-pty-after-close");
  p->result = 0;

cleanup:
  free(requests); free(expected);
  if (host) {
    if (held.lease) (void)hvir_terminal_release_frame(host, a, held.lease);
    if (replacement) (void)hvir_terminal_destroy(host, replacement);
    if (events) (void)hvir_terminal_destroy(host, events);
    if (large) (void)hvir_terminal_destroy(host, large);
    if (b) (void)hvir_terminal_destroy(host, b);
    if (a) (void)hvir_terminal_destroy(host, a);
    if (hvir_terminal_close(host) != HVIR_OK) p->result = 1;
  }
  pthread_mutex_lock(&p->mutex);
  p->finished = true;
  pthread_cond_signal(&p->condition);
  pthread_mutex_unlock(&p->mutex);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3 || (argc == 3 && strcmp(argv[2], "--frames"))) return 64;
  probe p = { .library = argv[1], .frames = argc == 3,
    .main_thread = pthread_self(),
    .mutex = PTHREAD_MUTEX_INITIALIZER, .condition = PTHREAD_COND_INITIALIZER };
  pthread_t worker;
  if (pthread_create(&worker, NULL, run_probe, &p)) return 70;
  pthread_mutex_lock(&p.mutex);
  while (!p.ready && !p.finished) pthread_cond_wait(&p.condition, &p.mutex);
  if (p.ready) {
    pthread_mutex_unlock(&p.mutex);
    hvir_terminal_status status;
    p.wrong_inspect = hvir_terminal_inspect(p.host, p.first, &status);
    p.wrong_feed = hvir_terminal_feed(p.host, p.first, 1, (const uint8_t *)"wrong", 5);
    pthread_mutex_lock(&p.mutex);
    p.inspected = true;
    pthread_cond_signal(&p.condition);
  }
  pthread_mutex_unlock(&p.mutex);
  if (pthread_join(worker, NULL)) return 70;
  pthread_cond_destroy(&p.condition);
  pthread_mutex_destroy(&p.mutex);
  if (p.result) return p.result;
  printf("{\"schema\":1,\"nativeFacade\":\"passed\",\"checks\":%u,"
    "\"owner\":\"pthread\",\"childCountChecked\":%s,\"ptyDescriptorCountChecked\":%s,"
    "\"frameRequested\":%s,\"frameKind\":%u,\"heldPixelsChecked\":%s,"
    "\"hardwareGpuQualified\":false}\n", p.checks,
    p.os_children_checked ? "true" : "false", p.os_ptys_checked ? "true" : "false",
    p.frames ? "true" : "false", p.frame_kind, p.frame_hashed ? "true" : "false");
  return 0;
}
