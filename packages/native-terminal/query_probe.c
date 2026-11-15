#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include "ghostty.h"
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Real ABI9 facade, one designated worker and the authoritative native Surface.
 * A second Surface is used only for foreign-token negatives, never as a mirror.
 * Deadlines and finite producers below contain fixed fixtures, not product caps. */
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  hvir_terminal_id id, foreign;
  uint64_t sequence, query, cursor, foreign_query;
  uint64_t boundaries[8];
  size_t boundary_count;
  uint64_t first_semantic_serial, last_semantic_serial, control_serial;
  uint32_t control_action;
  unsigned checks, cases, partial_counts, streamed_batches;
  size_t max_work, max_visited, max_chunk;
  uint64_t validated_bytes, copy_digest, large_bytes, large_chunks;
  bool initial_before_producer_end, failed;
} probe;
#define NEED(value, name) do { if (!check(p, (value), (name))) return false; } while (0)
static uint64_t clock_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static void yield_owner(void) {
  const struct timespec t = {.tv_nsec = 1000000};
  nanosleep(&t, NULL);
}
static bool check(probe *p, bool value, const char *contract) {
  p->checks++;
  if (!value) {
    p->failed = true;
    fprintf(stderr, "native-query-probe: %s\n", contract);
  }
  return value;
}
static uint64_t digest_bytes(uint64_t hash, const uint8_t *bytes, size_t length) {
  for (size_t i = 0; i < length; i++) hash = (hash ^ bytes[i]) * UINT64_C(1099511628211);
  return hash;
}
static void validated(probe *p, size_t length, uint64_t digest) {
  uint8_t encoded[8];
  for (unsigned i = 0; i < 8; i++) encoded[i] = (uint8_t)(digest >> (i * 8));
  p->copy_digest = digest_bytes(p->copy_digest, encoded, sizeof(encoded));
  p->validated_bytes += length;
}
static bool io_applied(probe *p, uint64_t mutation) {
  const uint64_t deadline = clock_ms() + 10000;
  do {
    hvir_terminal_status status;
    NEED(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK &&
      !status.failure && !status.input_failure, "parser-and-input-health");
    if (status.io_applied_sequence >= p->sequence && status.io_applied_mutation >= mutation) return true;
    yield_owner();
  } while (clock_ms() < deadline);
  NEED(false, "fixed-fixture-io-deadline");
  return false;
}
static bool feed_bytes(probe *p, const void *data, size_t length) {
  const uint8_t *bytes = data;
  for (size_t offset = 0; offset < length;) {
    size_t count = length - offset;
    if (count > HVIR_TERMINAL_FEED_MAX) count = HVIR_TERMINAL_FEED_MAX;
    NEED(hvir_terminal_feed(p->host, p->id, ++p->sequence, bytes + offset, count) == HVIR_OK,
      "bounded-real-parser-feed");
    offset += count;
  }
  return io_applied(p, 0);
}
static bool feed(probe *p, const char *text) { return feed_bytes(p, text, strlen(text)); }
static bool context(probe *p, hvir_terminal_selection_context *out) {
  NEED(hvir_terminal_query_context(p->host, p->id, &out->screen, &out->geometry_serial) == HVIR_OK &&
    out->screen <= 1 && out->geometry_serial, "atomic-current-parser-context-without-frame");
  return true;
}
static bool create(probe *p) {
  NEED(!p->id && !p->cursor && !p->query && !p->boundary_count, "fixture-previous-resources-settled");
  p->sequence = 0;
  NEED(hvir_terminal_create(p->host, 800, 600, &p->id) == HVIR_OK, "create-authoritative-surface");
  NEED(hvir_terminal_visibility(p->host, p->id, 0) == HVIR_OK, "query-does-not-require-presented-frame");
  return io_applied(p, 0);
}
static bool close_cursor(probe *p) {
  if (!p->cursor) return true;
  NEED(hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK, "targeted-owned-cursor-close");
  p->cursor = 0;
  return true;
}
static bool close_query(probe *p) {
  if (!p->query) return true;
  NEED(hvir_terminal_query_close(p->host, p->id, p->query) == HVIR_OK, "owned-query-close");
  p->query = 0;
  return true;
}
static bool destroy(probe *p) {
  if (!close_cursor(p) || !close_query(p)) return false;
  for (size_t i = 0; i < p->boundary_count; i++)
    NEED(hvir_terminal_boundary_close(p->host, p->id, p->boundaries[i]) == HVIR_OK, "owned-boundary-close");
  p->boundary_count = 0;
  p->first_semantic_serial = p->last_semantic_serial = 0;
  NEED(hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "destroy-query-surface");
  p->id = 0;
  return true;
}
static bool healthy_key(probe *p) {
  hvir_terminal_input_event event = {.kind = HVIR_INPUT_KEY, .key = GHOSTTY_KEY_X,
    .action = 1, .text = (const uint8_t *)"x", .text_length = 1};
  hvir_terminal_input_result out = {0};
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id, &event, false, &out);
  bool good = check(p, code == HVIR_OK && out.length == 1 && out.data && out.data[0] == 'x' &&
    out.source == 1, "native-key-encoding-progress-and-no-mode-change");
  uint64_t mutation = out.requested_mutation;
  hvir_terminal_input_result_free(&out);
  return good && io_applied(p, mutation);
}
static bool begin_query(probe *p, const char *needle, bool sensitive) {
  if (!close_query(p)) return false;
  NEED(hvir_terminal_query_begin(p->host, p->id, (const uint8_t *)needle, strlen(needle),
    sensitive, &p->query) == HVIR_OK && p->query, "native-literal-query-begin");
  return true;
}
static bool step(probe *p, hvir_terminal_query_status *out) {
  NEED(hvir_terminal_query_step(p->host, p->id, p->query, out) == HVIR_OK && !out->stale &&
    out->query == p->query && out->revision && out->status <= 2 &&
    out->work <= HVIR_TERMINAL_SELECTION_VISITS && out->visited <= HVIR_TERMINAL_SELECTION_VISITS,
    "actual-bounded-query-step");
  NEED(out->status != 0 || out->work || out->visited, "running-query-makes-measured-progress");
  if (out->work > p->max_work) p->max_work = out->work;
  if (out->visited > p->max_visited) p->max_visited = out->visited;
  return true;
}
static bool settled(probe *p, hvir_terminal_query_status *out) {
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!step(p, out)) return false;
    if (out->status == 2) return true;
    NEED(out->status != 1, "finite-accepted-source-does-not-idle-poll");
  } while (clock_ms() < deadline);
  NEED(false, "fixed-query-fixture-deadline");
  return false;
}
static bool at(probe *p, const hvir_terminal_query_status *status, size_t index,
    hvir_terminal_query_match *match) {
  hvir_terminal_query_page_result page = {0};
  NEED(hvir_terminal_query_page(p->host, p->id, p->query, status->revision, index, match, 1, &page) == HVIR_OK &&
    !page.stale && page.revision == status->revision && page.count == status->count && page.length == 1 &&
    match->index == index && match->occurrence && match->screen == 0, "indexed-query-owned-occurrence");
  return true;
}
static bool next(probe *p, uint8_t *data, size_t capacity, hvir_terminal_selection_result *out) {
  NEED(hvir_terminal_extract_next(p->host, p->id, p->cursor, data, capacity, out) == HVIR_OK &&
    !out->stale && out->cursor == p->cursor && out->length <= capacity &&
    out->length <= HVIR_TERMINAL_SELECTION_CHUNK && out->visited <= HVIR_TERMINAL_SELECTION_VISITS &&
    out->work <= HVIR_TERMINAL_SELECTION_VISITS && (out->done || out->length || out->visited || out->work),
    "bounded-native-read-data-and-work");
  if (out->length > p->max_chunk) p->max_chunk = out->length;
  if (out->work > p->max_work) p->max_work = out->work;
  if (out->visited > p->max_visited) p->max_visited = out->visited;
  return true;
}
static bool finish(probe *p, hvir_terminal_selection_result *out) {
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, out);
  p->cursor = 0;
  NEED(code == HVIR_OK && !out->stale, "finish-certifies-and-closes-read");
  return io_applied(p, out->requested_mutation);
}
static bool exact(probe *p, const char *expected) {
  size_t length = strlen(expected), offset = 0;
  uint64_t digest = UINT64_C(14695981039346656037);
  uint8_t bytes[7];
  hvir_terminal_selection_result out;
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    NEED(offset <= length && out.length <= length - offset &&
      !memcmp(bytes, expected + offset, out.length), "exact-UTF8-half-open-concatenation");
    offset += out.length;
    digest = digest_bytes(digest, bytes, out.length);
    if (out.done) {
      NEED(offset == length, "exact-completed-byte-length");
      if (!finish(p, &out)) return false;
      validated(p, offset, digest);
      return true;
    }
  } while (clock_ms() < deadline);
  NEED(false, "fixed-copy-fixture-deadline");
  return false;
}
static bool read_match(probe *p, uint64_t occurrence, const char *expected) {
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_range_begin(p->host, p->id, 1, p->query, occurrence, &ctx, &out) == HVIR_OK &&
    !out.stale && out.cursor, "independent-match-range-begin");
  p->cursor = out.cursor;
  return exact(p, expected);
}
static bool resolve_match_value(probe *p, uint64_t occurrence, bool reveal, bool expected_reveal,
    hvir_terminal_selection_result *observed) {
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, occurrence, reveal, &ctx, &out) == HVIR_OK &&
    !out.stale && out.cursor, "bounded-native-match-resolution-begin");
  p->cursor = out.cursor;
  uint8_t bytes[65536];
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    if (out.done) {
      if (!finish(p, &out)) return false;
      NEED(out.resolution_kind == 1 && out.resolved && out.revealed == expected_reveal &&
        out.match.occurrence == occurrence, "current-occurrence-resolution-not-selection");
      *observed = out;
      return true;
    }
  } while (clock_ms() < deadline);
  NEED(false, "fixed-resolve-fixture-deadline");
  return false;
}
static bool resolve_match(probe *p, uint64_t occurrence, bool reveal, bool expected_reveal) {
  hvir_terminal_selection_result observed;
  return resolve_match_value(p, occurrence, reveal, expected_reveal, &observed);
}
static bool stale_match(probe *p, uint64_t occurrence) {
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!context(p, &ctx)) return false;
  hvir_terminal_result code = hvir_terminal_query_resolve_begin(p->host, p->id, p->query,
    occurrence, false, &ctx, &out);
  if (out.cursor) p->cursor = out.cursor;
  NEED(!out.length && !out.resolved && !out.revealed, "stale-begin-never-grants-text-or-resolution");
  if (code == HVIR_BUSY && out.stale) return close_cursor(p);
  NEED(code == HVIR_OK && !out.stale && p->cursor, "stale-check-acquires-only-bounded-validation");
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  const uint64_t deadline = clock_ms() + 15000;
  do {
    code = hvir_terminal_extract_next(p->host, p->id, p->cursor, bytes, sizeof(bytes), &out);
    NEED(out.work <= HVIR_TERMINAL_SELECTION_VISITS && out.visited <= HVIR_TERMINAL_SELECTION_VISITS &&
      out.length <= sizeof(bytes), "stale-match-validation-honors-work-and-byte-bounds");
    NEED(!out.length && !out.resolved && !out.revealed, "old-occurrence-never-grants-text-or-resolution");
    if (out.work > p->max_work) p->max_work = out.work;
    if (out.visited > p->max_visited) p->max_visited = out.visited;
    if (code == HVIR_BUSY && out.stale) return close_cursor(p);
    NEED(code == HVIR_OK && !out.stale && (out.done || out.work || out.visited),
      "stale-match-validation-makes-bounded-progress");
    if (out.done) {
      code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
      p->cursor = 0;
      NEED(code == HVIR_BUSY && out.stale && !out.length && !out.resolved && !out.revealed,
        "old-content-occurrence-is-explicitly-stale-at-finish");
      return true;
    }
  } while (clock_ms() < deadline);
  NEED(false, "fixed-stale-match-validation-deadline");
  return false;
}
static bool selection_state(probe *p, hvir_terminal_selection_result *out) {
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, &ctx, out) == HVIR_OK,
    "observe-native-selection-state");
  return true;
}
static bool query_golden(probe *p, const char *needle, bool sensitive, const char *const *texts,
    size_t count, const uint32_t *rows, const uint32_t *columns) {
  hvir_terminal_query_status status;
  if (!begin_query(p, needle, sensitive) || !settled(p, &status)) return false;
  NEED(status.count == count, "baseline-literal-case-count");
  for (size_t i = 0; i < count; i++) {
    hvir_terminal_query_match match;
    if (!at(p, &status, i, &match)) return false;
    NEED((!rows || match.row == rows[i]) && (!columns || match.column == columns[i]),
      "oldest-first-left-to-right-order");
    if (!read_match(p, match.occurrence, texts[i])) return false;
  }
  p->cases++;
  return close_query(p);
}
static bool matching_goldens(probe *p) {
  if (!create(p) || !feed(p, "old TARGET target\r\nmid target TARGET\r\nnew Target\r\nlast target")) return false;
  const char *folded[] = {"TARGET", "target", "target", "TARGET", "Target", "target"};
  const uint32_t rows[] = {0, 0, 1, 1, 2, 3}, cols[] = {4, 11, 4, 11, 4, 5};
  const char *sensitive[] = {"target", "target", "target"};
  const uint32_t sr[] = {0, 1, 3}, sc[] = {11, 4, 5};
  const char *upper[] = {"TARGET", "TARGET"};
  const uint32_t ur[] = {0, 1}, uc[] = {4, 11};
  hvir_terminal_selection_result before, after;
  if (!selection_state(p, &before) || !query_golden(p, "target", false, folded, 6, rows, cols) ||
      !query_golden(p, "target", true, sensitive, 3, sr, sc) ||
      !query_golden(p, "TARGET", true, upper, 2, ur, uc) || !selection_state(p, &after)) return false;
  NEED(before.has_selection == after.has_selection && before.selection_serial == after.selection_serial,
    "search-and-copy-do-not-mutate-user-selection");
  if (!healthy_key(p) || !destroy(p) || !create(p)) return false;
  if (!feed(p, "\xc3\x84 \xc3\xa4 \xce\xa3 \xcf\x83 \xc4\xb0 i e\xcc\x81 \xc3\xa9 \xf0\x9f\x99\x82 aaaaa [a].*")) return false;
  const char *needles[] = {"\xc3\xa4", "\xcf\x83", "i", "e\xcc\x81", "\xc3\xa9", "\xf0\x9f\x99\x82", "[a].*"};
  for (size_t i = 0; i < sizeof(needles) / sizeof(needles[0]); i++) {
    const char *one[] = {needles[i]};
    if (!query_golden(p, needles[i], false, one, 1, NULL, NULL)) return false;
  }
  if (!query_golden(p, "e", false, NULL, 0, NULL, NULL) ||
      !query_golden(p, "\xcc\x81", false, NULL, 0, NULL, NULL)) return false;
  const char *overlap[] = {"aa", "aa", "aa", "aa"};
  const uint32_t orows[] = {0, 0, 0, 0}, ocols[] = {19, 20, 21, 22};
  if (!query_golden(p, "aa", true, overlap, 4, orows, ocols)) return false;
  return healthy_key(p) && destroy(p);
}
static bool exact_columns(probe *p, uint32_t columns) {
  hvir_terminal_status status;
  NEED(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK, "measured-fixture-geometry");
  uint32_t width = columns * status.geometry.cell_width + status.geometry.width - status.geometry.content_width;
  uint64_t serial = status.geometry.serial + 1;
  NEED(hvir_terminal_resize(p->host, p->id, serial, width, status.geometry.height) == HVIR_OK,
    "measured-public-resize-fixture");
  const uint64_t deadline = clock_ms() + 10000;
  do {
    NEED(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK && !status.failure,
      "resize-parser-health");
    if (status.geometry.serial == serial) {
      NEED(status.geometry.columns == columns, "exact-fixed-cell-grid");
      return true;
    }
    yield_owner();
  } while (clock_ms() < deadline);
  NEED(false, "fixed-resize-fixture-deadline");
  return false;
}
static bool wrapping_and_alt(probe *p) {
  if (!create(p) || !exact_columns(p, 8) || !feed(p, "abcue\xcc\x81\xf0\x9f\x99\x82wrap\r\nnextend")) return false;
  const char *wide[] = {"e\xcc\x81\xf0\x9f\x99\x82wrap"};
  const char *newline[] = {"wrap\nnext"};
  if (!query_golden(p, wide[0], true, wide, 1, NULL, NULL) ||
      !query_golden(p, "wrapnext", false, NULL, 0, NULL, NULL) ||
      !query_golden(p, newline[0], false, newline, 1, NULL, NULL) || !destroy(p) || !create(p)) return false;
  if (!feed(p, "normal target\r\nsecond target\x1b[?1049halternate TARGET")) return false;
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx)) return false;
  NEED(ctx.screen == 1, "actual-alt-screen-before-any-frame-acquisition");
  const char *primary[] = {"target", "target"};
  if (!query_golden(p, "target", false, primary, 2, NULL, NULL) ||
      !query_golden(p, "alternate", false, NULL, 0, NULL, NULL) || !begin_query(p, "target", true)) return false;
  hvir_terminal_query_status status;
  hvir_terminal_query_match match;
  if (!settled(p, &status) || !at(p, &status, 1, &match) || !resolve_match(p, match.occurrence, true, false)) return false;
  if (!feed(p, "\x1b[?1049l") || !context(p, &ctx)) return false;
  NEED(ctx.screen == 0, "actual-primary-return-before-any-frame-acquisition");
  if (!resolve_match(p, match.occurrence, false, false) || !read_match(p, match.occurrence, "target")) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool identity_and_foreign(probe *p) {
  if (!create(p) || !feed(p, "target tail\r\nsecond target") || !begin_query(p, "target", true)) return false;
  hvir_terminal_query_status status;
  hvir_terminal_query_match original, replacement, untouched, still_untouched;
  if (!settled(p, &status) || !at(p, &status, 1, &untouched) || !at(p, &status, 0, &original) || !feed(p, "\x1b[1;30Htail") ||
      !resolve_match(p, original.occurrence, false, false) || !settled(p, &status) || !at(p, &status, 0, &replacement)) return false;
  NEED(replacement.occurrence == original.occurrence, "same-row-outside-write-preserves-occurrence");
  if (!feed(p, "\x1b[1;1Htarget") || !stale_match(p, original.occurrence) || !settled(p, &status) ||
      !at(p, &status, 0, &replacement)) return false;
  NEED(replacement.occurrence != original.occurrence, "identical-inside-rewrite-gets-new-occurrence");
  if (!at(p, &status, 1, &still_untouched) || !resolve_match(p, untouched.occurrence, false, false) ||
      !read_match(p, untouched.occurrence, "target")) return false;
  NEED(status.count == 2 && still_untouched.occurrence == untouched.occurrence &&
    still_untouched.index == untouched.index, "inside-rewrite-preserves-other-occurrence-and-current-index");
  if (!read_match(p, replacement.occurrence, "target")) return false;
  NEED(hvir_terminal_create(p->host, 320, 200, &p->foreign) == HVIR_OK, "create-only-foreign-authority-negative");
  hvir_terminal_query_status foreign_status = {0};
  NEED(hvir_terminal_query_step(p->host, p->foreign, p->query, &foreign_status) == HVIR_BUSY &&
    foreign_status.stale, "foreign-surface-query-refused");
  NEED(hvir_terminal_query_begin(p->host, p->foreign, (const uint8_t *)"target", 6, true, &p->foreign_query) == HVIR_OK,
    "foreign-query-own-resource");
  NEED(hvir_terminal_query_step(p->host, p->id, p->foreign_query, &foreign_status) == HVIR_BUSY &&
    foreign_status.stale, "foreign-query-on-primary-refused");
  NEED(hvir_terminal_query_close(p->host, p->foreign, p->foreign_query) == HVIR_OK &&
    hvir_terminal_destroy(p->host, p->foreign) == HVIR_OK, "foreign-resource-cleanup");
  p->foreign = 0; p->foreign_query = 0;
  if (!feed(p, "\x1b[1;1Hxxxxxx") || !stale_match(p, replacement.occurrence) || !settled(p, &status)) return false;
  NEED(status.count == 1, "overwritten-match-refresh-count");
  if (!at(p, &status, 0, &still_untouched) || !read_match(p, untouched.occurrence, "target")) return false;
  NEED(still_untouched.occurrence == untouched.occurrence && still_untouched.index == 0,
    "unaffected-occurrence-survives-removal-with-updated-index");
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool resolver_query_lifetime(probe *p) {
  if (!create(p) || !feed(p, "target") || !begin_query(p, "target", true)) return false;
  hvir_terminal_query_status status;
  hvir_terminal_query_match match;
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!settled(p, &status) || !at(p, &status, 0, &match) || !context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, match.occurrence,
    true, &ctx, &out) == HVIR_OK && !out.stale && out.cursor,
    "resolver-acquires-originating-query-lifetime");
  p->cursor = out.cursor;
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    NEED(!out.resolved && !out.revealed, "validation-is-not-final-reveal-authority");
    if (out.done) break;
  } while (clock_ms() < deadline);
  NEED(out.done, "fixed-resolver-lifetime-validation-deadline");
  const uint64_t old_query = p->query;
  if (!begin_query(p, "target", true)) return false;
  NEED(p->query != old_query, "replacement-query-has-distinct-authority-with-unchanged-content");
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
  p->cursor = 0; // Finish owns the old cursor's sole physical close, even on refusal.
  NEED(code == HVIR_BUSY && out.stale && !out.resolved && !out.revealed,
    "closed-query-resolver-cannot-resurrect-old-highlight-at-finish");
  // A new resolver proves the refused Finish actually released the physical slot.
  if (!settled(p, &status) || !at(p, &status, 0, &match) || !context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, match.occurrence,
    false, &ctx, &out) == HVIR_OK && !out.stale && out.cursor,
    "refused-finish-releases-slot-for-current-query");
  p->cursor = out.cursor;
  if (!close_cursor(p)) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool selected_highlight_refresh(probe *p) {
  if (!create(p)) return false;
  hvir_terminal_status native;
  NEED(hvir_terminal_inspect(p->host, p->id, &native) == HVIR_OK && native.geometry.rows >= 6 &&
    native.geometry.columns >= 7, "selected-refresh-measured-active-tail-grid");
  if (!feed(p, "before\r\ntarget\r\nafter") || !begin_query(p, "target", true)) return false;
  hvir_terminal_query_status status;
  hvir_terminal_query_match match;
  hvir_terminal_selection_result out;
  if (!settled(p, &status) || !at(p, &status, 0, &match) ||
      !resolve_match_value(p, match.occurrence, true, true, &out)) return false;
  NEED(out.requested_mutation > 0, "real-selected-reveal-has-applied-mutation");
  NEED(out.match.row == 1, "selected-refresh-starts-at-known-active-row");
  if (!feed(p, "\x1b[1;1H\x1b[L") ||
      !resolve_match_value(p, match.occurrence, false, false, &out)) return false;
  NEED(out.match.row == 2 && out.requested_mutation > 0,
    "selected-id-relocation-refreshes-observed-row-without-reveal");
  if (!resolve_match_value(p, match.occurrence, false, false, &out)) return false;
  NEED(out.match.row == 2 && !out.requested_mutation,
    "unchanged-selected-resolution-does-not-schedule-presentation");
  // A second relocation is essential: an unchanged lookup owns no refresh authority.
  if (!feed(p, "\x1b[1;1H\x1b[L")) return false;
  hvir_terminal_selection_context ctx;
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, match.occurrence,
    false, &ctx, &out) == HVIR_OK && !out.stale && out.cursor,
    "second-relocation-acquires-real-selected-refresh");
  p->cursor = out.cursor;
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    if (out.done) break;
  } while (clock_ms() < deadline);
  NEED(out.done, "fixed-selected-refresh-validation-deadline");
  NEED(hvir_terminal_query_clear_reveal(p->host, p->id, p->query) == HVIR_OK,
    "targeted-clear-revokes-acquired-refresh-authority");
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
  p->cursor = 0;
  NEED(code == HVIR_BUSY && !out.stale && !out.resolved && !out.revealed &&
    !out.requested_mutation && !out.length, "revoked-refresh-cannot-republish-highlight-at-finish");
  if (!resolve_match_value(p, match.occurrence, false, false, &out) ||
      !read_match(p, match.occurrence, "target")) return false;
  NEED(out.match.row == 3 && !out.requested_mutation,
    "clear-highlight-preserves-current-occurrence-without-resurrection");
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool held_resolver_layout_race(probe *p) {
  if (!create(p) || !feed(p, "before\r\ntarget\r\nafter") || !begin_query(p, "target", true)) return false;
  hvir_terminal_status native;
  NEED(hvir_terminal_inspect(p->host, p->id, &native) == HVIR_OK && native.geometry.rows >= 6,
    "held-resolver-layout-fixture-has-room-for-retained-moves");
  hvir_terminal_query_status status;
  hvir_terminal_query_match match, current;
  hvir_terminal_selection_result out;
  hvir_terminal_selection_context ctx;
  if (!settled(p, &status) || !at(p, &status, 0, &match) ||
      !resolve_match(p, match.occurrence, true, true) || !context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, match.occurrence,
    false, &ctx, &out) == HVIR_OK && !out.stale && out.cursor,
    "held-resolver-acquires-before-structural-parser-edit");
  p->cursor = out.cursor;
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    NEED(!out.resolved && !out.revealed, "held-validation-has-no-final-authority");
    if (out.done) break;
  } while (clock_ms() < deadline);
  NEED(out.done, "fixed-held-resolver-pre-edit-validation-deadline");
  if (!feed(p, "\x1b[1;1H\x1b[L")) return false;
  hvir_terminal_result code = hvir_terminal_extract_next(p->host, p->id, p->cursor,
    bytes, sizeof(bytes), &out);
  NEED(out.work <= HVIR_TERMINAL_SELECTION_VISITS && out.visited <= HVIR_TERMINAL_SELECTION_VISITS,
    "held-resolver-refusal-remains-bounded");
  NEED(code == HVIR_BUSY && !out.stale && !out.length && !out.resolved && !out.revealed &&
    !out.requested_mutation, "structural-layout-race-is-busy-not-content-stale-at-next");
  code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
  p->cursor = 0; // Finish closes the refused physical cursor exactly once.
  NEED(code == HVIR_BUSY && !out.stale && !out.length && !out.resolved && !out.revealed &&
    !out.requested_mutation, "structural-layout-race-is-busy-not-content-stale-at-finish");
  if (!settled(p, &status) || !at(p, &status, match.index, &current)) return false;
  NEED(current.occurrence == match.occurrence, "layout-race-preserves-untouched-occurrence-id");
  if (!resolve_match_value(p, match.occurrence, false, false, &out) ||
      !read_match(p, match.occurrence, "target")) return false;
  NEED(out.match.row == match.row + 1 && out.requested_mutation > 0,
    "fresh-retry-refreshes-current-selected-row-after-held-busy");
  // Layout retry is not permission to keep an ID whose text was also overwritten.
  if (!feed(p, "\x1b[1;1H\x1b[L\x1b[4;1Hxxxxxx") ||
      !stale_match(p, match.occurrence) || !settled(p, &status)) return false;
  NEED(status.count == 0, "layout-plus-inside-write-invalidates-old-occurrence-on-fresh-retry");
  // Once content-stale is externally reported, a later move must not relabel it BUSY.
  if (!feed(p, "\x1b[4;1Htarget") || !settled(p, &status) ||
      !at(p, &status, 0, &current) || !context(p, &ctx)) return false;
  NEED(hvir_terminal_query_resolve_begin(p->host, p->id, p->query, current.occurrence,
    false, &ctx, &out) == HVIR_OK && !out.stale && out.cursor,
    "stale-latch-acquires-current-target-before-inside-write");
  p->cursor = out.cursor;
  const uint64_t latch_deadline = clock_ms() + 15000;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    if (out.done) break;
  } while (clock_ms() < latch_deadline);
  NEED(out.done && !out.resolved && !out.revealed, "stale-latch-captures-target-without-final-authority");
  if (!feed(p, "\x1b[4;1Htarget")) return false;
  code = hvir_terminal_extract_next(p->host, p->id, p->cursor, bytes, sizeof(bytes), &out);
  NEED(code == HVIR_BUSY && out.stale && !out.length && !out.resolved && !out.revealed &&
    !out.requested_mutation && out.work <= HVIR_TERMINAL_SELECTION_VISITS &&
    out.visited <= HVIR_TERMINAL_SELECTION_VISITS, "inside-write-first-reports-content-stale");
  if (!feed(p, "\x1b[1;1H\x1b[L")) return false;
  code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
  p->cursor = 0; // Even a latched refusal has one Finish-owned physical close.
  NEED(code == HVIR_BUSY && out.stale && !out.length && !out.resolved && !out.revealed &&
    !out.requested_mutation, "later-layout-cannot-relabel-reported-content-stale-at-finish");
  if (!settled(p, &status) || !at(p, &status, 0, &current) ||
      !read_match(p, current.occurrence, "target")) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool high_match_stream(probe *p) {
  if (!create(p)) return false;
  hvir_terminal_status native;
  NEED(hvir_terminal_inspect(p->host, p->id, &native) == HVIR_OK && native.geometry.columns >= 3,
    "high-match-measured-grid");
  size_t width = native.geometry.columns - 1, rows = 30001 / (width - 1) + 1;
  char line[4096];
  NEED(width + 2 < sizeof(line), "bounded-high-match-row-fixture");
  memset(line, 'a', width); line[width] = '\r'; line[width + 1] = '\n';
  for (size_t i = 0; i < rows; i++) if (!feed_bytes(p, line, width + 2)) return false;
  if (!begin_query(p, "aa", true)) return false;
  const uint64_t wanted = rows * (width - 1), deadline = clock_ms() + 15000;
  hvir_terminal_query_status status;
  hvir_terminal_query_match selected = {0};
  bool complete = false;
  while (clock_ms() < deadline) {
    if (!step(p, &status)) return false;
    if (status.count && status.count < wanted) p->partial_counts++;
    if (!selected.occurrence && status.count >= 2) {
      if (!at(p, &status, 1, &selected) || !read_match(p, selected.occurrence, "aa")) return false;
    }
    if (status.status == 2) { complete = true; break; }
    NEED(status.status == 0, "initial-pass-never-waits-for-source-quiescence");
    if (!feed(p, "noise\r\n")) return false;
    p->streamed_batches++;
  }
  NEED(complete && status.count == wanted && wanted > 10000 &&
    p->partial_counts > 0 && selected.occurrence, "live-high-match-finite-initial-completion-and-partial-counts");
  if (!feed(p, "aa\r\n") || !settled(p, &status)) return false;
  NEED(status.count == wanted + 1, "streaming-count-updates-before-producer-end");
  p->initial_before_producer_end = true; // Actual post-completion feed above precedes the end marker.
  hvir_terminal_query_match current;
  if (!at(p, &status, selected.index, &current)) return false;
  NEED(current.occurrence == selected.occurrence, "streaming-preserves-selected-id-and-index");
  if (!resolve_match(p, selected.occurrence, false, false) || !read_match(p, selected.occurrence, "aa") ||
      !feed(p, "producer-end\r\n")) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool eviction_and_reflow(probe *p) {
  if (!create(p) || !feed(p, "target\r\n") || !begin_query(p, "target", true)) return false;
  hvir_terminal_query_status status;
  hvir_terminal_query_match match;
  if (!settled(p, &status) || !at(p, &status, 0, &match)) return false;
  uint8_t flood[16384];
  memset(flood, 'q', sizeof(flood));
  for (size_t i = 78; i < sizeof(flood); i += 80) { flood[i] = '\r'; flood[i + 1] = '\n'; }
  bool evicted = false;
  for (unsigned batch = 0; batch < 1024; batch++) {
    if (!feed_bytes(p, flood, sizeof(flood))) return false;
    hvir_terminal_selection_context ctx;
    hvir_terminal_selection_result out = {0};
    if (!context(p, &ctx)) return false;
    hvir_terminal_result code = hvir_terminal_query_resolve_begin(p->host, p->id, p->query,
      match.occurrence, false, &ctx, &out);
    if (code == HVIR_BUSY && out.stale) { evicted = true; break; }
    NEED(code == HVIR_OK && out.cursor, "retained-occurrence-stays-usable-before-eviction");
    p->cursor = out.cursor;
    if (!close_cursor(p)) return false;
  }
  NEED(evicted, "fixed-retention-fixture-actually-evicted-old-occurrence");
  if (!begin_query(p, "target", true) || !settled(p, &status)) return false;
  NEED(status.count == 0, "evicted-text-not-recreated-as-new-occurrence");
  if (!destroy(p) || !create(p) || !feed(p, "target") || !begin_query(p, "target", true) ||
      !settled(p, &status) || !at(p, &status, 0, &match) || !exact_columns(p, 8) || !stale_match(p, match.occurrence)) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool boundary_events(probe *p, uint64_t *start, uint64_t *end) {
  const uint64_t deadline = clock_ms() + 10000;
  do {
    hvir_terminal_event event;
    hvir_terminal_result code = hvir_terminal_next_event(p->host, p->id, &event);
    if (code == HVIR_OK) {
      if (event.kind == 8) { p->control_serial = event.event_serial; p->control_action = event.action; }
      if (event.kind != 6) continue;
      NEED(event.boundary && p->boundary_count < sizeof(p->boundaries) / sizeof(p->boundaries[0]),
        "parser-origin-authenticated-boundary-token");
      p->boundaries[p->boundary_count++] = event.boundary;
      if (!p->first_semantic_serial) p->first_semantic_serial = event.event_serial;
      p->last_semantic_serial = event.event_serial;
      if (event.action == 1 || event.action == 3) *start = event.boundary;
      if (event.action == 4) *end = event.boundary;
      if (*start && *end) return true;
    } else {
      NEED(code == HVIR_BUSY, "bounded-semantic-event-delivery");
      yield_owner();
    }
  } while (clock_ms() < deadline);
  NEED(false, "fixed-semantic-event-fixture-deadline");
  return false;
}
static bool range_begin(probe *p, uint64_t start, uint64_t end) {
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_range_begin(p->host, p->id, 2, start, end, &ctx, &out) == HVIR_OK &&
    !out.stale && out.cursor, "positive-owned-semantic-cursor-including-empty");
  p->cursor = out.cursor;
  return true;
}
static bool semantic_read(probe *p, uint64_t start, uint64_t end, const char *expected) {
  return range_begin(p, start, end) && exact(p, expected);
}
static bool stale_read(probe *p) {
  const uint64_t deadline = clock_ms() + 15000;
  uint8_t data[65536];
  hvir_terminal_selection_result out;
  do {
    hvir_terminal_result code = hvir_terminal_extract_next(p->host, p->id, p->cursor, data, sizeof(data), &out);
    NEED(out.length <= sizeof(data) && out.work <= 8192 && out.visited <= 8192,
      "stale-copy-still-honors-step-bounds");
    if (code == HVIR_BUSY && out.stale) {
      NEED(out.length == 0, "stale-read-never-forwards-unvalidated-bytes");
      return close_cursor(p);
    }
    NEED(code == HVIR_OK && !out.stale, "stale-copy-only-known-refusal");
    if (out.done) {
      code = hvir_terminal_extract_finish(p->host, p->id, p->cursor, &out);
      p->cursor = 0;
      NEED(code == HVIR_BUSY && out.stale, "finish-rejects-copy-after-captured-content-change");
      return true;
    }
  } while (clock_ms() < deadline);
  NEED(false, "fixed-stale-read-fixture-deadline");
  return false;
}
static bool semantic_current_and_stale(probe *p) {
  uint64_t a = 0, b = 0;
  if (!create(p) || !feed(p, "\x1b]133;A\x07" "alpha\r\nmiddle\r\nomega" "\x1b]133;B\x07") ||
      !boundary_events(p, &a, &b) || !semantic_read(p, a, b, "alpha\nmiddle\nomega") ||
      !feed(p, "\x1b[2;1HCHANGE") || !semantic_read(p, a, b, "alpha\nCHANGE\nomega")) return false;
  if (!range_begin(p, a, b) || !feed(p, "\x1b[2;1HCHANGE") || !stale_read(p)) return false;
  if (!range_begin(p, a, b)) return false;
  uint8_t part[4]; hvir_terminal_selection_result out;
  const uint64_t deadline = clock_ms() + 15000;
  do {
    if (!next(p, part, sizeof(part), &out)) return false;
    if (out.length || out.done) break;
  } while (clock_ms() < deadline);
  NEED(out.length > 0 && !out.done, "actual-partial-copy-precedes-captured-content-mutation");
  if (!feed(p, "\x1b[2;1Hmiddle") || !stale_read(p)) return false;
  p->cases++;
  if (!healthy_key(p) || !destroy(p) || !create(p)) return false;
  a = 0; b = 0;
  if (!feed(p, "\x1b]133;A\x07" "alpha" "\x1b]133;B\x07") || !boundary_events(p, &a, &b) ||
      !range_begin(p, a, b) || !feed(p, "\x1b[1;30Htail") || !exact(p, "alpha")) return false;
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool semantic_cursor_and_blank(probe *p) {
  uint64_t a = 0, b = 0;
  if (!create(p) || !feed(p, "\x1b]133;A\x07" "tail\r\nbelow" "\x1b]133;B\x07") ||
      !boundary_events(p, &a, &b) || !feed(p, "\x1b[1;3H") || !semantic_read(p, a, 0, "ta")) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_boundary end = {0};
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_boundary_capture_end(p->host, p->id, &ctx, &end) == HVIR_OK && end.boundary &&
    !end.stale && end.screen == 0 && end.column == 2, "command-time-parser-cursor-not-viewport-tail");
  p->boundaries[p->boundary_count++] = end.boundary;
  if (!semantic_read(p, a, end.boundary, "ta") || !feed(p, "\x1b[?1049halt") ||
      !semantic_read(p, a, 0, "ta") || !feed(p, "\x1b[?1049l") || !destroy(p) || !create(p)) return false;
  a = 0; b = 0;
  if (!feed(p, "\x1b]133;A\x07" "alpha\r\n" "\x1b]133;B\x07") ||
      !boundary_events(p, &a, &b) || !semantic_read(p, a, b, "alpha\n") ||
      !destroy(p) || !create(p)) return false;
  a = 0; b = 0;
  if (!feed(p, "\x1b]133;A\x07" "\r\n\r\n" "\x1b]133;B\x07") ||
      !boundary_events(p, &a, &b) || !semantic_read(p, a, b, "\n\n")) return false;
  p->cases++;
  return destroy(p);
}
static bool empty_busy_cancel_reset(probe *p) {
  uint64_t a = 0, b = 0;
  if (!create(p) || !feed(p, "\x1b]133;A\x07\x1b]133;B\x07") || !boundary_events(p, &a, &b) ||
      !range_begin(p, a, b)) return false;
  hvir_terminal_selection_context ctx;
  hvir_terminal_selection_result out = {0};
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_range_begin(p->host, p->id, 2, a, b, &ctx, &out) == HVIR_BUSY && !out.stale && !out.cursor,
    "empty-cursor-still-owns-single-physical-read-slot");
  NEED(hvir_terminal_extract_close(p->host, p->id, p->cursor + 1) == HVIR_OK,
    "wrong-cursor-close-idempotent-without-cancelling-owner");
  if (!feed(p, "x") || !exact(p, "") || !range_begin(p, a, b) || !close_cursor(p) ||
      !range_begin(p, a, b) || !exact(p, "")) return false;
  if (!range_begin(p, a, b) || !context(p, &ctx)) return false;
  uint64_t old_serial = p->last_semantic_serial;
  NEED(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_RESET, &ctx, &out) == HVIR_OK &&
    out.effect_serial_cutoff > 0, "ordered-reset-cutoff");
  uint64_t cutoff = out.effect_serial_cutoff;
  if (!io_applied(p, out.requested_mutation) || !stale_read(p)) return false;
  a = 0; b = 0; p->first_semantic_serial = 0;
  if (!feed(p, "\x1b]133;A\x07new\x1b]133;B\x07") || !boundary_events(p, &a, &b)) return false;
  NEED(old_serial < cutoff && cutoff < p->first_semantic_serial &&
    p->control_serial == cutoff && p->control_action == 1,
    "reset-cutoff-orders-preclear-and-postclear-parser-facts");
  old_serial = p->last_semantic_serial;
  if (!context(p, &ctx)) return false;
  NEED(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_TERMINAL_CLEAR, &ctx, &out) == HVIR_OK &&
    out.effect_serial_cutoff > old_serial, "ordered-clear-cutoff");
  cutoff = out.effect_serial_cutoff;
  if (!io_applied(p, out.requested_mutation)) return false;
  a = 0; b = 0; p->first_semantic_serial = 0;
  if (!feed(p, "\x1b]133;A\x07new\x1b]133;B\x07") || !boundary_events(p, &a, &b)) return false;
  NEED(old_serial < cutoff && cutoff < p->first_semantic_serial &&
    p->control_serial == cutoff && p->control_action == 2,
    "clear-cutoff-matches-ordered-control-and-brackets-parser-facts");
  p->cases++;
  return healthy_key(p) && destroy(p);
}
static bool semantic_large(probe *p) {
  if (!create(p)) return false;
  hvir_terminal_status status;
  NEED(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK && status.geometry.columns > 2,
    "large-semantic-measured-grid");
  size_t columns = status.geometry.columns - 1, stride = columns * 2 + 1;
  size_t rows = (HVIR_TERMINAL_TEXT_MAX + 65536u) / stride + 1;
  uint8_t row[4096], batch[HVIR_TERMINAL_FEED_MAX];
  NEED(columns * 2 + 2 <= sizeof(row), "bounded-two-byte-large-fixture-row");
  for (size_t i = 0; i < columns; i++) { row[i * 2] = 0xce; row[i * 2 + 1] = 0xbb; }
  row[columns * 2] = '\r'; row[columns * 2 + 1] = '\n';
  if (!feed(p, "\x1b]133;A\x07")) return false;
  for (size_t produced = 0; produced < rows;) {
    size_t count = sizeof(batch) / (columns * 2 + 2);
    if (count > rows - produced) count = rows - produced;
    for (size_t i = 0; i < count; i++) memcpy(batch + i * (columns * 2 + 2), row, columns * 2 + 2);
    size_t length = count * (columns * 2 + 2);
    if (produced + count == rows) length -= 2;
    if (!feed_bytes(p, batch, length)) return false;
    produced += count;
  }
  uint64_t a = 0, b = 0;
  if (!feed(p, "\x1b]133;B\x07") || !boundary_events(p, &a, &b) || !range_begin(p, a, b)) return false;
  const size_t expected = rows * stride - 1;
  uint8_t bytes[HVIR_TERMINAL_SELECTION_CHUNK];
  hvir_terminal_selection_result out;
  uint64_t digest = UINT64_C(14695981039346656037), deadline = clock_ms() + 30000;
  size_t copied = 0;
  bool done = false, input_progress = false;
  do {
    if (!next(p, bytes, sizeof(bytes), &out)) return false;
    NEED(copied <= expected && out.length <= expected - copied, "large-semantic-length-bound");
    for (size_t i = 0; i < out.length; i++) {
      size_t position = (copied + i) % stride;
      uint8_t wanted = position == stride - 1 ? '\n' : position % 2 ? 0xbb : 0xce;
      NEED(bytes[i] == wanted, "large-semantic-exact-UTF8-with-hard-newlines");
    }
    digest = digest_bytes(digest, bytes, out.length);
    copied += out.length; done = out.done; p->large_chunks++;
    if (!done && !input_progress) { if (!healthy_key(p)) return false; input_progress = true; }
  } while (!done && clock_ms() < deadline);
  NEED(done && copied == expected && copied > HVIR_TERMINAL_TEXT_MAX && input_progress,
    "uncapped-complete-semantic-copy-beyond-diagnostic-buffer-with-input-progress");
  if (!finish(p, &out)) return false;
  validated(p, copied, digest); p->large_bytes = copied; p->cases++;
  return healthy_key(p) && destroy(p);
}
static void *run(void *data) {
  probe *p = data;
  if (!check(p, hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open-real-native-host")) return NULL;
  if (!matching_goldens(p) || !wrapping_and_alt(p) || !identity_and_foreign(p) ||
      !resolver_query_lifetime(p) || !selected_highlight_refresh(p) || !held_resolver_layout_race(p) || !high_match_stream(p) || !eviction_and_reflow(p) || !semantic_current_and_stale(p) ||
      !semantic_cursor_and_blank(p) || !empty_busy_cancel_reset(p) || !semantic_large(p)) goto cleanup;
cleanup:
  if (p->cursor) check(p, hvir_terminal_extract_close(p->host, p->id, p->cursor) == HVIR_OK, "failure-cursor-cleanup");
  if (p->query) check(p, hvir_terminal_query_close(p->host, p->id, p->query) == HVIR_OK, "failure-query-cleanup");
  if (p->foreign_query) check(p, hvir_terminal_query_close(p->host, p->foreign, p->foreign_query) == HVIR_OK, "failure-foreign-query-cleanup");
  if (p->foreign) check(p, hvir_terminal_destroy(p->host, p->foreign) == HVIR_OK, "failure-foreign-surface-cleanup");
  if (p->id) check(p, hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "failure-surface-cleanup");
  check(p, hvir_terminal_close(p->host) == HVIR_OK, "close-real-native-host");
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  probe p = {.library = argv[1], .copy_digest = UINT64_C(14695981039346656037)};
  pthread_t worker;
  if (pthread_create(&worker, NULL, run, &p) || pthread_join(worker, NULL)) return 2;
  printf("{\"kind\":\"native-query\",\"passed\":%s,\"checks\":%u,\"queryCases\":%u,"
    "\"maxWork\":%zu,\"maxVisited\":%zu,\"maxChunkBytes\":%zu,\"validatedBytes\":%"PRIu64","
    "\"copyDigestFnv1a64\":\"%016"PRIx64"\",\"partialCounts\":%u,\"streamedBatches\":%u,"
    "\"initialCompletedBeforeProducerEnd\":%s,\"largeSemanticBytes\":%"PRIu64",\"largeChunks\":%"PRIu64","
    "\"frameAcquisitions\":0,\"hardwareGpuQualified\":false}\n",
    p.failed ? "false" : "true", p.checks, p.cases, p.max_work, p.max_visited, p.max_chunk,
    p.validated_bytes, p.copy_digest, p.partial_counts, p.streamed_batches,
    p.initial_before_producer_end ? "true" : "false", p.large_bytes, p.large_chunks);
  return p.failed ? 1 : 0;
}
