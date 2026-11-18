#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Synthetic readback diagnostic, not hardware qualification. A separate owner
 * keeps frame leases distinct from the zero-frame retained-query oracle. */
typedef struct {
  uint8_t *bytes;
  size_t length;
  uint32_t width, height, stride, color_space;
} pixels;
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  uint64_t id, sequence, mutation, query, cursor;
  unsigned checks, frames;
  bool failed, highlight_differs, transition_restores, cleanup;
} highlight_probe;
static uint64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static void progress(void) {
  const struct timespec t = {.tv_nsec = 1000000};
  nanosleep(&t, NULL);
}
static bool check(highlight_probe *p, bool value, const char *name) {
  p->checks++;
  if (!value) {
    p->failed = true;
    fprintf(stderr, "native-query-highlight:%s\n", name);
  }
  return value;
}
#define NEED(value, name) do { if (!check(p, (value), (name))) return false; } while (0)
static bool applied(highlight_probe *p, uint64_t geometry) {
  const uint64_t deadline = now_ms() + 5000;
  do {
    hvir_terminal_status status;
    NEED(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK &&
      !status.failure && !status.input_failure, "healthy-parser");
    if (status.io_applied_sequence >= p->sequence && status.io_applied_mutation >= p->mutation &&
        (!geometry || status.geometry.serial == geometry)) return true;
    progress();
  } while (now_ms() < deadline);
  NEED(false, "fixed-fixture-io-deadline");
  return false;
}
static bool feed(highlight_probe *p, const char *text) {
  NEED(hvir_terminal_feed(p->host, p->id, ++p->sequence,
    (const uint8_t *)text, strlen(text)) == HVIR_OK, "one-owned-parser-feed");
  return applied(p, 0);
}
static bool capture(highlight_probe *p, pixels *out) {
  const uint64_t deadline = now_ms() + 5000;
  do {
    hvir_terminal_frame frame;
    hvir_terminal_result code = hvir_terminal_take_frame(p->host, p->id, &frame);
    if (code == HVIR_OK) {
      p->frames++;
      bool current = frame.stream_sequence >= p->sequence && frame.snapshot_mutation >= p->mutation;
      bool copied = false;
      if (current) {
        size_t capacity = (size_t)frame.width * frame.height * 4;
        out->bytes = malloc(capacity);
        if (out->bytes) {
          copied = hvir_terminal_copy_frame(p->host, p->id, frame.lease, out->bytes,
            capacity, &out->length, &out->stride) == HVIR_OK && out->length > 0;
          out->width = frame.width; out->height = frame.height;
          out->color_space = frame.color_space;
        }
      }
      bool released = hvir_terminal_release_frame(p->host, p->id, frame.lease) == HVIR_OK;
      NEED(released, "every-acquired-frame-released");
      if (current) { NEED(copied, "fresh-fenced-bgra-readback"); return true; }
    } else NEED(code == HVIR_BUSY, "only-missing-frame-is-busy");
    progress();
  } while (now_ms() < deadline);
  NEED(false, "fresh-frame-deadline");
  return false;
}
static bool same(const pixels *a, const pixels *b) {
  return a->width == b->width && a->height == b->height && a->stride == b->stride &&
    a->color_space == b->color_space && a->length == b->length &&
    !memcmp(a->bytes, b->bytes, a->length);
}
static bool select_match(highlight_probe *p) {
  static const uint8_t needle[] = "highlight";
  NEED(hvir_terminal_query_begin(p->host, p->id, needle, sizeof(needle) - 1, true,
    &p->query) == HVIR_OK && p->query, "query-owned-by-presented-primary");
  hvir_terminal_query_status status;
  const uint64_t deadline = now_ms() + 5000;
  do {
    NEED(hvir_terminal_query_step(p->host, p->id, p->query, &status) == HVIR_OK &&
      !status.stale, "bounded-query-step");
    if (status.status == 2) break;
    progress();
  } while (now_ms() < deadline);
  NEED(status.status == 2 && status.count == 1, "one-completed-literal-occurrence");
  hvir_terminal_query_match match;
  hvir_terminal_query_page_result page;
  NEED(hvir_terminal_query_page(p->host, p->id, p->query, status.revision, 0, &match, 1,
    &page) == HVIR_OK && !page.stale && page.length == 1 && match.screen == 0,
    "owned-occurrence-page");
  hvir_terminal_selection_context ctx = {0};
  NEED(hvir_terminal_query_context(p->host, p->id, &ctx.screen, &ctx.geometry_serial) == HVIR_OK,
    "current-resolution-context");
  hvir_terminal_selection_result read;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, match.occurrence, true,
    &ctx, &read) == HVIR_OK && !read.stale && read.cursor, "selected-match-read-begin");
  p->cursor = read.cursor;
  const uint64_t read_deadline = now_ms() + 5000;
  do {
    uint8_t bytes[64];
    NEED(hvir_terminal_extract_next(p->host, p->id, p->cursor, bytes, sizeof(bytes), &read) == HVIR_OK &&
      !read.stale, "selected-match-read-progress");
    if (read.done) break;
  } while (now_ms() < read_deadline);
  NEED(read.done, "selected-match-read-completed");
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &read);
  p->cursor = 0;
  NEED(code == HVIR_OK && !read.stale && read.resolved && read.revealed,
    "selected-highlight-committed");
  p->mutation = read.requested_mutation;
  return applied(p, 0);
}
static bool run(highlight_probe *p, pixels *baseline, pixels *selected, pixels *restored) {
  NEED(hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open-designated-owner");
  NEED(hvir_terminal_create(p->host, 640, 192, &p->id) == HVIR_OK, "create-owned-surface");
  hvir_terminal_appearance appearance = {.font_family = "monospace", .font_size = 13,
    .cursor_shape = 0, .cursor_blink = 0, .ligatures = false};
  appearance.colors[0] = 0x112233; appearance.colors[1] = 0xeeddcc;
  appearance.colors[2] = 0xddaa77; appearance.colors[3] = 0x000000;
  appearance.colors[4] = 0x3759bd; appearance.colors[5] = 0xffffff;
  for (size_t i = 6; i < 22; i++) appearance.colors[i] = 0x304050 + (uint32_t)i * 0x030201;
  NEED(hvir_terminal_appearance_set(p->host, p->id, 1, &appearance, &p->mutation) == HVIR_OK &&
    p->mutation && applied(p, 0), "deterministic-appearance-applied");
  NEED(hvir_terminal_resize_scaled(p->host, p->id, 2, 640, 192, 1) == HVIR_OK &&
    applied(p, 2), "appearance-geometry-acknowledged");
  /* Hide the cursor as well as disabling blink: cursor restoration cannot make
   * otherwise identical source pixels differ after the screen round trip. */
  if (!feed(p, "\x1b[?25lhighlight fixture\r\n") || !capture(p, baseline) ||
      !select_match(p) || !capture(p, selected)) return false;
  p->highlight_differs = !same(baseline, selected);
  NEED(p->highlight_differs, "committed-highlight-changes-actual-pixels");
  /* Deliberately no query close/step/restart between committing the highlight
   * and presenting the original screen again. Both transitions share ONE feed. */
  if (!feed(p, "\x1b[?47h\x1b[?47l") || !capture(p, restored)) return false;
  p->transition_restores = same(baseline, restored);
  NEED(p->transition_restores, "aba-screen-transition-removes-old-highlight-pixels");
  return true;
}
static void *worker(void *data) {
  highlight_probe *p = data;
  pixels baseline = {0}, selected = {0}, restored = {0};
  bool passed = run(p, &baseline, &selected, &restored);
  free(baseline.bytes); free(selected.bytes); free(restored.bytes);
  bool cleanup = true;
  if (p->cursor) cleanup = check(p, hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK,
    "read-cleanup") && cleanup;
  if (p->query) cleanup = check(p, hvir_terminal_query_close(p->host, p->id, p->query) == HVIR_OK,
    "query-cleanup") && cleanup;
  if (p->id) cleanup = check(p, hvir_terminal_destroy(p->host, p->id) == HVIR_OK,
    "surface-cleanup") && cleanup;
  if (p->host) cleanup = check(p, hvir_terminal_close(p->host) == HVIR_OK,
    "host-cleanup") && cleanup;
  p->cleanup = cleanup;
  p->failed = p->failed || !passed;
  return NULL;
}
int hvir_query_highlight_probe(const char *library) {
  highlight_probe p = {.library = library};
  pthread_t thread;
  if (pthread_create(&thread, NULL, worker, &p) || pthread_join(thread, NULL)) return 70;
  printf("{\"kind\":\"native-query-highlight\",\"passed\":%s,\"checks\":%u,"
    "\"frameAcquisitions\":%u,\"highlightPixelsDiffer\":%s,\"abaRestoresBaseline\":%s,"
    "\"cleanupChecked\":%s,\"hardwareGpuQualified\":false}\n",
    p.failed ? "false" : "true", p.checks, p.frames, p.highlight_differs ? "true" : "false",
    p.transition_restores ? "true" : "false", p.cleanup ? "true" : "false");
  return p.failed ? 1 : 0;
}
