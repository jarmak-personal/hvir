#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include "ghostty.h"
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <inttypes.h>

/* Public ABI regression proof, on the designated caller and the actual parser.
 * Only fixed synthetic fixtures are read; their contents are never logged. */
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  uint64_t id, cursor, sequence;
  unsigned checks, mutations, sources, link_candidates, autoscrolls;
  uint64_t large_bytes, large_chunks, large_visits, large_work;
  unsigned large_columns, large_rows;
  bool failed;
} probe;
static bool check(probe *p, bool value, const char *name) {
  p->checks++;
  if (!value) {
    fprintf(stderr, "native-selection:%s\n", name);
    p->failed = true;
  }
  return value;
}
#define REQUIRE(value, name) do { if (!check(p, (value), (name))) return false; } while (0)
static uint64_t milliseconds(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static void progress(void) {
  struct timespec time = {.tv_nsec = 1000000};
  nanosleep(&time, NULL);
}
static bool inspect(probe *p, hvir_terminal_status *status) {
  REQUIRE(hvir_terminal_inspect(p->host, p->id, status) == HVIR_OK &&
    !status->failure && !status->input_failure, "parser-input-healthy");
  return true;
}
static bool create(probe *p) {
  REQUIRE(hvir_terminal_create(p->host, 640, 128, &p->id) == HVIR_OK, "create");
  p->sequence = 0;
  uint64_t deadline = milliseconds() + 5000;
  do {
    hvir_terminal_status status;
    if (!inspect(p, &status)) return false;
    if (status.geometry.serial == 1) return true;
    progress();
  } while (milliseconds() < deadline);
  return check(p, false, "initial-geometry");
}
static bool destroy(probe *p) {
  if (p->cursor) {
    REQUIRE(hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK,
      "owned-cursor-close");
    p->cursor = 0;
  }
  REQUIRE(hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "destroy");
  p->id = 0;
  return true;
}
static bool feed(probe *p, const char *text) {
  REQUIRE(hvir_terminal_feed(p->host, p->id, ++p->sequence,
    (const uint8_t *)text, strlen(text)) == HVIR_OK, "feed");
  return true;
}
static bool context(probe *p, hvir_terminal_selection_context *out,
    hvir_terminal_geometry *geometry) {
  hvir_terminal_status status;
  if (!inspect(p, &status)) return false;
  *out = (hvir_terminal_selection_context){.screen = 0,
    .geometry_serial = status.geometry.serial};
  if (geometry) *geometry = status.geometry;
  return true;
}
static bool select_all(probe *p, const hvir_terminal_selection_context *ctx) {
  hvir_terminal_selection_result selected;
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_ALL, ctx,
    &selected) == HVIR_OK && selected.has_selection, "select-all");
  REQUIRE(hvir_terminal_extract_begin(p->host, p->id, selected.selection_serial,
    ctx, &selected) == HVIR_OK && selected.cursor, "extract-begin");
  p->cursor = selected.cursor;
  return true;
}
static bool next(probe *p, uint8_t *bytes, size_t capacity,
    hvir_terminal_selection_result *out) {
  REQUIRE(hvir_terminal_extract_next(p->host, p->id, p->cursor, bytes, capacity,
    out) == HVIR_OK, "next");
  REQUIRE(out->length <= capacity && out->visited <= HVIR_TERMINAL_SELECTION_VISITS &&
    out->work <= HVIR_TERMINAL_SELECTION_VISITS, "bounded-next");
  REQUIRE(out->done || out->length || out->visited || out->work, "actual-progress");
  return true;
}
static bool finish(probe *p) {
  hvir_terminal_selection_result out;
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id,
    p->cursor, &out);
  p->cursor = 0; /* Finish closes the owned cursor, including on refusal. */
  REQUIRE(code == HVIR_OK, "finish-certifies-complete-copy");
  return true;
}
static bool exact_copy(probe *p, const char *expected) {
  size_t offset = 0, length = strlen(expected);
  uint8_t bytes[7];
  bool done = false;
  /* Fixed tiny fixtures bound this test loop, not the product's source size. */
  for (unsigned call = 0; !done && call < 2048; call++) {
    hvir_terminal_selection_result out;
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    REQUIRE(out.length <= length - offset &&
      !memcmp(bytes, expected + offset, out.length), "exact-source-bytes");
    offset += out.length;
    done = out.done;
  }
  REQUIRE(done && offset == length, "complete-source");
  return finish(p);
}
static bool healthy_key(probe *p) {
  hvir_terminal_input_result key;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id,
    &(hvir_terminal_input_event){.kind = HVIR_INPUT_KEY,
      .key = GHOSTTY_KEY_ENTER, .action = 1}, false, &key);
  bool correct = code == HVIR_OK && key.length == 1 && key.data[0] == '\r';
  hvir_terminal_input_result_free(&key);
  REQUIRE(correct, "next-key-after-copy-or-revocation");
  hvir_terminal_status status;
  return inspect(p, &status);
}
typedef struct {
  const char *name, *bytes;
  unsigned phase; /* before first read, partial read, or complete before Finish */
  int action;
  bool retained;
} mutation_case;
static const mutation_case mutations[] = {
  {"before-first-fast-ascii", "\x1b[1;1HX", 0, -1, false},
  {"partial-scalar", "\x1b[1;1H\xe7\x95\x8c", 1, -1, false},
  {"partial-grapheme", "\x1b[1;1Ha\xcc\x81", 1, -1, false},
  {"partial-erase-line", "\x1b[1;1H\x1b[2K", 1, -1, false},
  {"partial-erase-display", "\x1b[2J", 1, -1, false},
  {"partial-insert-chars", "\x1b[1;1H\x1b[2@", 1, -1, false},
  {"partial-delete-chars", "\x1b[1;1H\x1b[2P", 1, -1, false},
  {"partial-erase-chars", "\x1b[1;1H\x1b[2X", 1, -1, false},
  {"partial-insert-lines", "\x1b[1;1H\x1b[L", 1, -1, false},
  {"partial-delete-lines", "\x1b[1;1H\x1b[M", 1, -1, false},
  {"partial-scroll-up-retains-text", "\x1b[S", 1, -1, true},
  {"partial-scroll-down", "\x1b[T", 1, -1, false},
  {"partial-alternate-screen", "\x1b[?1049h", 1, -1, false},
  {"partial-RIS", "\x1b" "c", 1, -1, false},
  {"after-done-before-finish", "\x1b[1;1HX", 2, -1, false},
  {"partial-terminal-clear", NULL, 1, HVIR_SELECTION_TERMINAL_CLEAR, false},
  {"partial-terminal-reset", NULL, 1, HVIR_SELECTION_RESET, false},
};
static bool mutation_proof(probe *p, const mutation_case *test) {
  if (!create(p) || !feed(p,
      "abcdefghijklmnopqrstuvwxyz0123456789\r\nsecond stable row\r\nthird retained row"))
    return false;
  const char *expected =
    "abcdefghijklmnopqrstuvwxyz0123456789\nsecond stable row\nthird retained row";
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx, NULL) || !select_all(p, &ctx)) return false;
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  size_t offset = 0;
  hvir_terminal_selection_result out = {0};
  if (test->phase) {
    unsigned calls = 0;
    do {
      if (!next(p, bytes, test->phase == 2 ? sizeof(bytes) : 8, &out)) return false;
      REQUIRE(out.length <= strlen(expected) - offset &&
        !memcmp(bytes, expected + offset, out.length), "initial-exact-bytes");
      offset += out.length;
    } while (test->phase == 2 && !out.done && ++calls < 100);
    REQUIRE(test->phase != 1 || (offset > 0 && !out.done), "actual-partial-read");
    REQUIRE(test->phase != 2 || (out.done && offset == strlen(expected)),
      "actual-complete-before-mutation");
  }
  if (test->action >= 0) {
    REQUIRE(hvir_terminal_selection(p->host, p->id, (uint32_t)test->action,
      &ctx, &out) == HVIR_OK, "selection-mutation");
  } else if (!feed(p, test->bytes)) return false;
  hvir_terminal_result code;
  if (test->phase == 2) {
    code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
    p->cursor = 0;
  } else code = hvir_terminal_extract_next(p->host, p->id, p->cursor,
    bytes, sizeof(bytes), &out);
  if (test->retained) {
    unsigned calls = 0;
    do {
      REQUIRE(code == HVIR_OK && out.length <= strlen(expected) - offset &&
        !memcmp(bytes, expected + offset, out.length), "retained-scroll-exact");
      offset += out.length;
      if (out.done) break;
      code = hvir_terminal_extract_next(p->host, p->id, p->cursor,
        bytes, sizeof(bytes), &out);
    } while (++calls < 100);
    REQUIRE(out.done && offset == strlen(expected), "retained-scroll-complete");
    if (!finish(p)) return false;
  } else REQUIRE(code == HVIR_BUSY && out.stale, test->name);
  if (!healthy_key(p) || !destroy(p)) return false;
  p->mutations++;
  return true;
}
static bool source(probe *p, const char *bytes, const char *expected) {
  if (!create(p) || !feed(p, bytes)) return false;
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx, NULL) || !select_all(p, &ctx) || !exact_copy(p, expected) ||
      !healthy_key(p) || !destroy(p)) return false;
  p->sources++;
  return true;
}
static bool pointer(probe *p, const hvir_terminal_selection_context *ctx,
    const hvir_terminal_geometry *g, double x, double y, int action, uint32_t mods) {
  hvir_terminal_input_event event = {.kind = HVIR_INPUT_POINTER,
    .x = (g->padding_left + g->cell_width * x) / g->backing_scale,
    .y = (g->padding_top + g->cell_height * y) / g->backing_scale,
    .modifiers = mods, .has_button = action >= 0, .button = 1,
    .action = action >= 0 ? (uint32_t)action : 0,
    .selection_enabled = true, .selection_screen = ctx->screen,
    .selection_geometry = ctx->geometry_serial};
  hvir_terminal_input_result out;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id, &event, true, &out);
  bool correct = code == HVIR_OK && !out.length && !out.selection_result;
  hvir_terminal_input_result_free(&out);
  REQUIRE(correct, "readonly-pointer-no-PTY-bytes");
  return true;
}
static bool rectangle(probe *p) {
  if (!create(p) || !feed(p, "abcde\r\nfghij\r\nklmno")) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_geometry g;
  /* The mature native platform convention is Alt on macOS, Ctrl+Alt elsewhere. */
#ifdef __APPLE__
  const uint32_t modifiers = 4;
#else
  const uint32_t modifiers = 6;
#endif
  if (!context(p, &ctx, &g) || !pointer(p, &ctx, &g, 1.25, .5, 1, modifiers) ||
      !pointer(p, &ctx, &g, 3.9, 2.5, -1, modifiers) ||
      !pointer(p, &ctx, &g, 3.9, 2.5, 0, modifiers)) return false;
  hvir_terminal_selection_result out;
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, &ctx,
    &out) == HVIR_OK && out.has_selection, "rectangle-selection");
  REQUIRE(hvir_terminal_extract_begin(p->host, p->id, out.selection_serial,
    &ctx, &out) == HVIR_OK && out.cursor, "rectangle-begin");
  p->cursor = out.cursor;
  if (!exact_copy(p, "bcd\nghi\nlmn") || !healthy_key(p) || !destroy(p)) return false;
  p->sources++;
  return true;
}
static bool reflow(probe *p) {
  const char *text = "abcdefghijklmnopqrstuvwxyz0123456789";
  if (!create(p) || !feed(p, text)) return false;
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx, NULL) || !select_all(p, &ctx)) return false;
  uint8_t bytes[8];
  hvir_terminal_selection_result out;
  if (!next(p, bytes, sizeof(bytes), &out)) return false;
  REQUIRE(out.length > 0 && !out.done, "reflow-actual-partial-read");
  REQUIRE(hvir_terminal_resize_scaled(p->host, p->id, 2, 160, 128, 1) == HVIR_OK,
    "resize-reflow");
  uint64_t deadline = milliseconds() + 5000;
  hvir_terminal_status status;
  do {
    if (!inspect(p, &status)) return false;
    if (status.geometry.serial == 2) break;
    progress();
  } while (milliseconds() < deadline);
  REQUIRE(status.geometry.serial == 2, "resize-acknowledged");
  REQUIRE(hvir_terminal_extract_next(p->host, p->id, p->cursor, bytes,
    sizeof(bytes), &out) == HVIR_BUSY && out.stale, "reflow-revokes-old-copy");
  REQUIRE(hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK,
    "reflow-close");
  p->cursor = 0;
  if (!context(p, &ctx, NULL) || !select_all(p, &ctx) || !exact_copy(p, text) ||
      !healthy_key(p) || !destroy(p)) return false;
  p->mutations++;
  p->sources++;
  return true;
}
static bool cancellation(probe *p) {
  if (!create(p) || !feed(p, "selected")) return false;
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx, NULL) || !select_all(p, &ctx)) return false;
  uint64_t cancelled = p->cursor;
  REQUIRE(hvir_terminal_extract_close(p->host, p->id, cancelled) == HVIR_OK,
    "cancel-owned-copy");
  p->cursor = 0;
  if (!select_all(p, &ctx)) return false;
  REQUIRE(p->cursor != cancelled &&
    hvir_terminal_extract_close(p->host, p->id, cancelled) == HVIR_OK,
    "old-close-cannot-close-new-copy");
  return exact_copy(p, "selected") && healthy_key(p) && destroy(p);
}
static bool link_pointer(probe *p, const hvir_terminal_selection_context *ctx,
    const hvir_terminal_geometry *g, double column, int action, uint32_t modifiers,
    bool read_only, bool candidate, bool reporting) {
  hvir_terminal_input_event event = {.kind = HVIR_INPUT_POINTER,
    .x = (g->padding_left + g->cell_width * column) / g->backing_scale,
    .y = (g->padding_top + g->cell_height * .5) / g->backing_scale,
    .has_button = action >= 0, .button = 1,
    .action = action >= 0 ? (uint32_t)action : 0, .modifiers = modifiers,
    .selection_enabled = true, .selection_screen = ctx->screen,
    .selection_geometry = ctx->geometry_serial};
  hvir_terminal_input_result out;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id, &event, read_only,
    &out);
  bool correct = code == HVIR_OK && out.link_candidate == candidate &&
    !out.selection_result && (reporting ? out.captured && out.length > 0 : !out.length);
  hvir_terminal_input_result_free(&out);
  REQUIRE(correct, "native-link-intent-disposition");
  return true;
}
static bool link_candidates(probe *p) {
  if (!create(p) || !feed(p, "link target")) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_geometry g;
  if (!context(p, &ctx, &g)) return false;
  /* Both browser modifiers are accepted on both platforms. The native
   * ctrlOrSuper helper means only Super on macOS, only Ctrl elsewhere. */
  for (unsigned i = 0; i < 3; i++) {
    uint32_t modifier = i == 0 ? 2 : i == 1 ? 8 : 0;
    if (!link_pointer(p, &ctx, &g, .25, 1, modifier, true, false, false) ||
        !link_pointer(p, &ctx, &g, .25, 0, modifier, true, modifier != 0, false))
      return false;
    p->link_candidates++;
  }
  if (!link_pointer(p, &ctx, &g, .25, 1, 2, true, false, false) ||
      !link_pointer(p, &ctx, &g, 4.9, -1, 2, true, false, false) ||
      !link_pointer(p, &ctx, &g, 4.9, 0, 2, true, false, false)) return false;
  p->link_candidates++;
  if (!feed(p, "\x1b[?1000h\x1b[?1006h") ||
      !link_pointer(p, &ctx, &g, .25, 1, 2, false, false, true) ||
      !link_pointer(p, &ctx, &g, .25, 0, 2, false, false, true)) return false;
  p->link_candidates++;
  /* The same reporting mode must not emit reports for retained readonly input. */
  if (!link_pointer(p, &ctx, &g, .25, 1, 2, true, false, false) ||
      !link_pointer(p, &ctx, &g, .25, 0, 2, true, true, false)) return false;
  p->link_candidates++;
  return healthy_key(p) && destroy(p);
}
static bool top_row(probe *p, const hvir_terminal_selection_context *ctx,
    const hvir_terminal_geometry *g, unsigned *row) {
  hvir_terminal_selection_result out;
  hvir_terminal_link_query facts;
  uint8_t uri[128]; size_t written = 0;
  REQUIRE(hvir_terminal_link_row_begin(p->host, p->id,
    (g->padding_left + g->cell_width * .25) / g->backing_scale,
    (g->padding_top + g->cell_height * .5) / g->backing_scale,
    ctx, &out, &facts, uri, sizeof(uri), &written) == HVIR_OK && out.cursor &&
    !written, "current-viewport-row-begin");
  p->cursor = out.cursor;
  char text[32]; size_t length = 0;
  bool done = false;
  for (unsigned call = 0; !done && call < 128; call++) {
    uint8_t bytes[7];
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    REQUIRE(length + out.length < sizeof(text), "fixed-row-fixture-size");
    memcpy(text + length, bytes, out.length);
    length += out.length;
    done = out.done;
  }
  REQUIRE(done, "viewport-row-complete");
  text[length] = 0;
  if (!finish(p)) return false;
  REQUIRE(sscanf(text, "row%u", row) == 1, "viewport-row-identity");
  return true;
}
static bool scrolled(probe *p, const hvir_terminal_selection_context *ctx,
    const hvir_terminal_geometry *g, unsigned before, bool down, unsigned *after) {
  uint64_t deadline = milliseconds() + 5000;
  do {
    hvir_terminal_status status;
    if (!inspect(p, &status) || !top_row(p, ctx, g, after)) return false;
    if (down ? *after >= before + 2 : *after + 2 <= before) return true;
    progress();
  } while (milliseconds() < deadline);
  return check(p, false, "real-timer-viewport-extension");
}
static bool stopped(probe *p, const hvir_terminal_selection_context *ctx,
    const hvir_terminal_geometry *g) {
  unsigned initial;
  hvir_terminal_selection_result selected;
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, ctx,
    &selected) == HVIR_OK, "stopped-selection-state");
  uint64_t serial = selected.selection_serial;
  if (!top_row(p, ctx, g, &initial)) return false;
  /* Negative observation across several genuine 15ms timer periods. */
  uint64_t deadline = milliseconds() + 100;
  do {
    hvir_terminal_status status;
    unsigned current;
    if (!inspect(p, &status) || !top_row(p, ctx, g, &current)) return false;
    REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, ctx,
      &selected) == HVIR_OK && selected.selection_serial == serial && current == initial,
      "cleanup-stops-selection-and-viewport");
    progress();
  } while (milliseconds() < deadline);
  return true;
}
static bool autoscroll(probe *p) {
  if (!create(p)) return false;
  char source[1024]; size_t length = 0;
  for (unsigned row = 0; row < 100; row++)
    length += (size_t)snprintf(source + length, sizeof(source) - length,
      "row%03u\r\n", row);
  if (!feed(p, source)) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_geometry g;
  if (!context(p, &ctx, &g)) return false;
  unsigned before, after, middle = g.rows / 2;
  if (!top_row(p, &ctx, &g, &before) ||
      !pointer(p, &ctx, &g, .75, middle + .5, 1, 0) ||
      !pointer(p, &ctx, &g, .25, -2, -1, 0) ||
      !scrolled(p, &ctx, &g, before, false, &after) ||
      !pointer(p, &ctx, &g, .25, -2, 0, 0) ||
      !top_row(p, &ctx, &g, &after)) return false;
  char expected[1024]; length = 0;
  for (unsigned row = after; row < before + middle; row++)
    length += (size_t)snprintf(expected + length, sizeof(expected) - length,
      "row%03u\n", row);
  REQUIRE(length + 2 < sizeof(expected), "fixed-autoscroll-fixture-size");
  expected[length++] = 'r'; expected[length] = 0;
  hvir_terminal_selection_result selected;
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, &ctx,
    &selected) == HVIR_OK && selected.has_selection, "autoscroll-selection-exists");
  REQUIRE(hvir_terminal_extract_begin(p->host, p->id, selected.selection_serial,
    &ctx, &selected) == HVIR_OK && selected.cursor, "autoscroll-selection-begin");
  p->cursor = selected.cursor;
  if (!exact_copy(p, expected) || !stopped(p, &ctx, &g)) return false;
  p->autoscrolls++;
  if (!top_row(p, &ctx, &g, &before) ||
      !pointer(p, &ctx, &g, .75, middle + .5, 1, 0) ||
      !pointer(p, &ctx, &g, .25, g.rows + 2, -1, 0) ||
      !scrolled(p, &ctx, &g, before, true, &after)) return false;
  hvir_terminal_input_result blur;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id,
    &(hvir_terminal_input_event){.kind = HVIR_INPUT_FOCUS}, true, &blur);
  bool no_write = code == HVIR_OK && blur.length == 0;
  hvir_terminal_input_result_free(&blur);
  REQUIRE(no_write, "readonly-focus-cleanup-no-write");
  if (!stopped(p, &ctx, &g) || !healthy_key(p) || !destroy(p)) return false;
  p->autoscrolls++;
  return true;
}
static bool large_copy(probe *p) {
  if (!create(p)) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_geometry g;
  if (!context(p, &ctx, &g)) return false;
  /* Single-cell two-byte Greek keeps native retained cells below the existing
   * retention budget while exceeding the independent 1MiB diagnostic read. */
  uint8_t line[2048], batch[HVIR_TERMINAL_FEED_MAX];
  size_t row_bytes = (size_t)g.columns * 2 + 2;
  REQUIRE(g.columns > 0 && row_bytes <= sizeof(line), "fixed-large-row-fixture");
  for (size_t x = 0; x < g.columns; x++) {
    line[x * 2] = 0xce; line[x * 2 + 1] = 0xbb; /* U+03BB */
  }
  line[row_bytes - 2] = '\r'; line[row_bytes - 1] = '\n';
  size_t stride = row_bytes - 1;
  size_t rows = (HVIR_TERMINAL_TEXT_MAX + 65536u) / stride + 1;
  p->large_columns = g.columns;
  p->large_rows = (unsigned)rows;
  for (size_t produced = 0; produced < rows;) {
    size_t count = sizeof(batch) / row_bytes;
    if (count > rows - produced) count = rows - produced;
    for (size_t row = 0; row < count; row++)
      memcpy(batch + row * row_bytes, line, row_bytes);
    REQUIRE(hvir_terminal_feed(p->host, p->id, ++p->sequence, batch,
      count * row_bytes) == HVIR_OK, "large-source-bounded-feed");
    produced += count;
  }
  if (!select_all(p, &ctx)) return false;
  size_t expected = rows * stride - 1, copied = 0;
  uint8_t output[HVIR_TERMINAL_SELECTION_CHUNK];
  bool done = false;
  /* This fixed test's known byte count bounds its progress loop. Native reads
   * themselves have only per-step budgets, with no product total-source cap. */
  for (size_t call = 0; !done && call < expected; call++) {
    hvir_terminal_selection_result out;
    if (!next(p, output, sizeof(output), &out)) return false;
    REQUIRE(out.length <= expected - copied, "large-copy-exact-length-bound");
    bool exact = true;
    for (size_t i = 0; i < out.length; i++) {
      size_t position = (copied + i) % stride;
      uint8_t byte = position == stride - 1 ? '\n' : position % 2 ? 0xbb : 0xce;
      if (output[i] != byte) { exact = false; break; }
    }
    REQUIRE(exact, "large-copy-exact-UTF8-and-row-boundaries");
    copied += out.length;
    p->large_chunks++; p->large_visits += out.visited; p->large_work += out.work;
    done = out.done;
  }
  REQUIRE(done && copied == expected && copied > HVIR_TERMINAL_TEXT_MAX,
    "complete-copy-exceeds-diagnostic-read-limit");
  p->large_bytes = copied;
  return finish(p) && healthy_key(p) && destroy(p);
}
static bool source_proofs(probe *p) {
  if (!source(p, "alpha\r\nA\xe7\x95\x8c" "e\xcc\x81" "B",
      "alpha\nA\xe7\x95\x8c" "e\xcc\x81" "B") ||
      !source(p, "a\tb\r\n\r\n end", "a       b\n\n end")) return false;
  if (!create(p)) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_geometry g;
  if (!context(p, &ctx, &g)) return false;
  char wrapped[2048];
  REQUIRE(g.columns + 5 < sizeof(wrapped), "fixed-wrap-fixture-size");
  memset(wrapped, 'w', g.columns);
  memcpy(wrapped + g.columns, "tail", 5);
  if (!feed(p, wrapped) || !select_all(p, &ctx) || !exact_copy(p, wrapped) ||
      !healthy_key(p) || !destroy(p)) return false;
  p->sources++;
  return rectangle(p) && reflow(p) && cancellation(p) && link_candidates(p) &&
    autoscroll(p) && large_copy(p);
}
static void *run(void *argument) {
  probe *p = argument;
  if (!check(p, hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open"))
    return NULL;
  for (size_t i = 0; i < sizeof(mutations) / sizeof(mutations[0]); i++)
    if (!mutation_proof(p, &mutations[i])) break;
  if (!p->failed) source_proofs(p);
  /* Attempt every acquired resource's cleanup even after an earlier refusal. */
  if (p->cursor) {
    check(p, hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK,
      "failure-owned-cursor-close");
    p->cursor = 0;
  }
  if (p->id) {
    check(p, hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "failure-destroy");
    p->id = 0;
  }
  check(p, hvir_terminal_close(p->host) == HVIR_OK, "close");
  p->host = NULL;
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  probe p = {.library = argv[1]};
  pthread_t worker;
  if (pthread_create(&worker, NULL, run, &p) || pthread_join(worker, NULL)) return 2;
  if (p.failed) return 1;
  printf("{\"kind\":\"native-selection\",\"passed\":true,\"checks\":%u,"
    "\"mutationCases\":%u,\"sourceCases\":%u,\"linkCandidateCases\":%u,\"autoscrollCases\":%u,"
    "\"largeCopyBytes\":%"PRIu64",\"largeCopyChunks\":%"PRIu64","
    "\"largeCopyCells\":%"PRIu64",\"largeCopyWork\":%"PRIu64","
    "\"largeCopyColumns\":%u,\"largeCopyRows\":%u,"
    "\"cleanupChecked\":true,\"hardwareGpuQualified\":false}\n",
    p.checks, p.mutations, p.sources, p.link_candidates, p.autoscrolls,
    p.large_bytes, p.large_chunks, p.large_visits, p.large_work,
    p.large_columns, p.large_rows);
  return 0;
}
