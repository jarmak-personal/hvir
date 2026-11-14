#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include "ghostty.h"
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
/* Fixed fixtures against the real pinned engine. Only this worker owns the
 * native facade; no terminal payload is emitted in diagnostics. */
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  hvir_terminal_id id;
  uint64_t sequence, held_lease, selection_cursor;
  unsigned checks;
  size_t wheel_capacity, wheel_bytes;
  uint64_t wheel_ms;
  int failed;
} probe;
static uint64_t now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static void progress(void) {
  const struct timespec t = {.tv_nsec = 1000000}; nanosleep(&t, NULL);
}
static bool check(probe *p, bool ok, const char *name) {
  p->checks++;
  if (!ok) { fprintf(stderr, "native-input-probe: %s\n", name); p->failed = 1; }
  return ok;
}
#define REQUIRE(value, name) do { if (!check(p, (value), (name))) goto done; } while (0)
static bool feed(probe *p, const char *s) {
  return hvir_terminal_feed(p->host, p->id, ++p->sequence,
    (const uint8_t *)s, strlen(s)) == HVIR_OK;
}
static bool applied(probe *p, uint64_t serial) {
  uint64_t deadline = now_ms() + 5000;
  hvir_terminal_status status;
  do {
    if (hvir_terminal_inspect(p->host, p->id, &status) != HVIR_OK ||
        status.failure || status.input_failure) return false;
    if (status.io_applied_mutation >= serial) return true;
    progress();
  } while (now_ms() < deadline);
  return false;
}
static bool input(probe *p, hvir_terminal_input_event event, bool read_only,
    const char *expected, size_t length, uint32_t source) {
  hvir_terminal_input_result result;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id, &event, read_only, &result);
  if (result.length != length) fprintf(stderr, "native-input-probe: encoded length=%zu expected=%zu\n", result.length, length);
  bool ok = check(p, code == HVIR_OK, "input-result") &&
    check(p, result.length == length && (!length || !memcmp(result.data, expected, length)), "exact-encoded-bytes") &&
    check(p, result.source == source && result.capacity >= length, "explicit-source-capacity");
  uint64_t mutation = result.requested_mutation;
  hvir_terminal_input_result_free(&result);
  return ok && applied(p, mutation);
}
static bool replies_applied(probe *p) {
  const uint64_t deadline = now_ms() + 5000;
  hvir_terminal_status status;
  do {
    if (hvir_terminal_inspect(p->host, p->id, &status) != HVIR_OK || status.failure) return false;
    if (status.io_applied_sequence >= p->sequence) return true;
    progress();
  } while (now_ms() < deadline);
  return false;
}
static bool resized(probe *p, uint64_t serial, double scale, hvir_terminal_status *status) {
  if (hvir_terminal_resize_scaled(p->host, p->id, serial, 800, 600, scale) != HVIR_OK) return false;
  const uint64_t deadline = now_ms() + 5000;
  do {
    if (hvir_terminal_inspect(p->host, p->id, status) != HVIR_OK || status->failure) return false;
    if (status->geometry.serial == serial) return status->geometry.backing_scale == scale;
    progress();
  } while (now_ms() < deadline);
  return false;
}
static uint64_t frame_hash(probe *p, const hvir_terminal_frame *frame) {
  if (frame->kind == 2) return 1; /* No CPU import of a real DMA-BUF in this proof. */
  size_t capacity = (size_t)frame->width * frame->height * 4;
  if (!capacity || capacity > HVIR_TERMINAL_PIXEL_MAX) return 0;
  uint8_t *pixels = malloc(capacity); if (!pixels) return 0;
  size_t written = 0; uint32_t stride = 0;
  hvir_terminal_result code = hvir_terminal_copy_frame(p->host, p->id, frame->lease,
    pixels, capacity, &written, &stride);
  uint64_t hash = 1469598103934665603ULL;
  if (code != HVIR_OK || written != capacity || stride != frame->width * 4) hash = 0;
  else for (size_t i = 0; i < written; i++) hash = (hash ^ pixels[i]) * 1099511628211ULL;
  free(pixels); return hash;
}
static bool completed(probe *p, uint64_t mutation, hvir_terminal_frame *frame) {
  const uint64_t deadline = now_ms() + 5000;
  do {
    hvir_terminal_status status;
    if (hvir_terminal_inspect(p->host, p->id, &status) != HVIR_OK || status.failure) return false;
    hvir_terminal_result code = hvir_terminal_take_frame(p->host, p->id, frame);
    if (code == HVIR_OK) {
      if (frame->snapshot_mutation >= mutation && frame->stream_sequence == p->sequence &&
          frame->geometry_serial == status.geometry.serial) { p->held_lease = frame->lease; return true; }
      if (hvir_terminal_release_frame(p->host, p->id, frame->lease) != HVIR_OK) return false;
    } else if (code != HVIR_BUSY) return false;
    progress();
  } while (now_ms() < deadline);
  return false;
}
static bool key(probe *p, uint32_t key, uint32_t mods, uint32_t action,
    const char *text, const char *expected) {
  return input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_KEY,
    .key=key, .modifiers=mods, .action=action, .text=(const uint8_t *)text,
    .text_length=strlen(text), .unshifted_codepoint=key == GHOSTTY_KEY_C ? 'c' : 0},
    false, expected, strlen(expected), 1);
}
/* ABI8 uses the same worker, parser and renderer as every assertion above. */
static bool selection_context(probe *p, uint32_t screen,
    hvir_terminal_selection_context *context, hvir_terminal_geometry *geometry) {
  hvir_terminal_status status;
  hvir_terminal_frame frame;
  if (!replies_applied(p) || hvir_terminal_inspect(p->host, p->id, &status) != HVIR_OK ||
      !completed(p, status.io_applied_mutation, &frame)) return false;
  bool ok = check(p, frame.screen == screen, "completed-frame-actual-screen");
  *context = (hvir_terminal_selection_context){.screen=frame.screen,
    .geometry_serial=frame.geometry_serial};
  *geometry = status.geometry;
  if (hvir_terminal_release_frame(p->host, p->id, frame.lease) != HVIR_OK) return false;
  p->held_lease = 0;
  return ok;
}
static bool selection_command(probe *p, uint32_t action,
    const hvir_terminal_selection_context *context, hvir_terminal_selection_result *out) {
  return check(p, hvir_terminal_selection(p->host, p->id, action, context, out) == HVIR_OK,
    "selection-command") && applied(p, out->requested_mutation);
}
static bool selection_pointer(probe *p, hvir_terminal_selection_context context,
    hvir_terminal_geometry geometry, double column, double row, int action,
    uint32_t modifiers, bool read_only, uint64_t *serial) {
  hvir_terminal_input_event event = {.kind=HVIR_INPUT_POINTER,
    .x=(geometry.padding_left + geometry.cell_width * column) / geometry.backing_scale,
    .y=(geometry.padding_top + geometry.cell_height * row) / geometry.backing_scale,
    .modifiers=modifiers, .has_button=action >= 0, .button=1,
    .action=action >= 0 ? (uint32_t)action : 0,
    .selection_enabled=true,.selection_screen=context.screen,
    .selection_geometry=context.geometry_serial};
  hvir_terminal_input_result out;
  hvir_terminal_result code = hvir_terminal_input(p->host, p->id, &event, read_only, &out);
  bool ok = check(p, code == HVIR_OK && out.selection_result == 0, "native-selection-input-metadata") &&
    check(p, out.length == 0 && out.source == 1, "selection-no-pty-wire");
  if (serial) *serial = out.selection_serial;
  uint64_t mutation = out.requested_mutation;
  hvir_terminal_input_result_free(&out);
  return ok && applied(p, mutation);
}
static bool selection_drain(probe *p, uint64_t cursor, const char *expected,
    bool require_clicked_zero) {
  uint8_t bytes[7]; size_t total = 0, wanted = strlen(expected);
  hvir_terminal_selection_result out = {0};
  bool done = false;
  for (unsigned calls = 0; calls < 10000 && !done; calls++) {
    hvir_terminal_result code = hvir_terminal_extract_next(p->host, p->id, cursor,
      bytes, sizeof(bytes), &out);
    if (!check(p, code == HVIR_OK && !out.stale && out.cursor == cursor &&
        out.length <= sizeof(bytes) && out.visited <= HVIR_TERMINAL_SELECTION_VISITS &&
        out.work <= HVIR_TERMINAL_SELECTION_VISITS && (out.done || out.length || out.visited || out.work),
        "bounded-native-selection-chunk")) return false;
    if (!check(p, total + out.length <= wanted &&
        !memcmp(bytes, expected + total, out.length), "native-selection-exact-concatenation")) return false;
    total += out.length; done = out.done;
  }
  if (!check(p, done && total == wanted, "native-selection-completed-exact-length")) return false;
  hvir_terminal_result code = hvir_terminal_extract_finish(p->host, p->id, cursor, &out);
  p->selection_cursor = 0;
  return check(p, code == HVIR_OK && !out.stale, "native-selection-finish-valid") &&
    check(p, !require_clicked_zero || (out.has_clicked_offset && out.clicked_offset == 0),
      "wide-tail-click-offset-is-head-zero");
}
static bool selection_copy(probe *p, const hvir_terminal_selection_context *context,
    uint64_t serial, const char *expected) {
  hvir_terminal_selection_result out;
  if (!check(p, hvir_terminal_extract_begin(p->host, p->id, serial, context, &out) == HVIR_OK &&
      out.cursor != 0, "native-selection-begin-owned-cursor")) return false;
  p->selection_cursor = out.cursor;
  return selection_drain(p, out.cursor, expected, false);
}
static bool selection_proof(probe *p) {
  hvir_terminal_selection_context context;
  hvir_terminal_geometry geometry;
  hvir_terminal_selection_result out;
  uint64_t serial = 0;
  REQUIRE(feed(p, "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[Halpha\r\nA\xe7\x95\x8c" "e\xcc\x81" "B"),
    "selection-alternate-unicode-fixture");
  REQUIRE(selection_context(p, 1, &context, &geometry), "selection-completed-alternate-context");
  REQUIRE(selection_pointer(p, context, geometry, .25, .5, 1, 0, true, NULL), "readonly-native-selection-press");
  REQUIRE(selection_pointer(p, context, geometry, 4.9, .5, -1, 0, true, NULL), "readonly-native-selection-drag");
  REQUIRE(selection_pointer(p, context, geometry, 4.9, .5, 0, 0, true, &serial), "readonly-native-selection-release");
  REQUIRE(serial && selection_copy(p, &context, serial, "alpha"), "readonly-native-drag-copy-exact");
  REQUIRE(selection_command(p, HVIR_SELECTION_ALL, &context, &out) && out.has_selection,
    "native-select-all-unicode");
  REQUIRE(selection_copy(p, &context, out.selection_serial, "alpha\nA\xe7\x95\x8c" "e\xcc\x81" "B"),
    "native-select-all-exact-wide-combining");
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, &context, &out) == HVIR_OK &&
    hvir_terminal_extract_begin(p->host, p->id, out.selection_serial, &context, &out) == HVIR_OK && out.cursor,
    "native-cancel-active-copy-begin");
  p->selection_cursor = out.cursor;
  hvir_terminal_link_query busy_facts; uint8_t busy_uri[256]; size_t busy_length = 0;
  REQUIRE(hvir_terminal_link_row_begin(p->host, p->id, 1, 1, &context, &out,
    &busy_facts, busy_uri, sizeof(busy_uri), &busy_length) == HVIR_BUSY && !out.cursor,
    "row-fallback-does-not-replace-owned-copy");
  REQUIRE(hvir_terminal_extract_close(p->host, p->id, p->selection_cursor) == HVIR_OK,
    "native-cancel-active-copy-owned-cursor");
  p->selection_cursor = 0;
  REQUIRE(selection_command(p, HVIR_SELECTION_TERMINAL_CLEAR, &context, &out), "native-clear-before-softwrap");
  char wrap[2048];
  REQUIRE(geometry.columns + 5 < sizeof(wrap), "softwrap-fixture-local-buffer");
  memset(wrap, 'w', geometry.columns); memcpy(wrap + geometry.columns, "tail", 5);
  REQUIRE(feed(p, wrap) && replies_applied(p), "native-softwrap-fixture-feed");
  REQUIRE(selection_command(p, HVIR_SELECTION_ALL, &context, &out) &&
    selection_copy(p, &context, out.selection_serial, wrap), "native-softwrap-without-invented-newline");
  REQUIRE(selection_command(p, HVIR_SELECTION_TERMINAL_CLEAR, &context, &out) &&
    feed(p, "alpha") && replies_applied(p), "native-copy-tracker-fixture");
  REQUIRE(selection_command(p, HVIR_SELECTION_ALL, &context, &out), "native-copy-tracker-select");
  REQUIRE(hvir_terminal_extract_begin(p->host, p->id, out.selection_serial, &context, &out) == HVIR_OK && out.cursor,
    "native-unrelated-row-copy-begin");
  p->selection_cursor = out.cursor;
  REQUIRE(feed(p, "\x1b[5;1Hunrelated\x1b[1;6H") && replies_applied(p), "same-page-unrelated-row-output");
  REQUIRE(selection_drain(p, p->selection_cursor, "alpha", false), "unrelated-row-output-does-not-starve-copy");
  REQUIRE(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_STATE, &context, &out) == HVIR_OK,
    "selection-survives-copy-completion");
  REQUIRE(hvir_terminal_extract_begin(p->host, p->id, out.selection_serial, &context, &out) == HVIR_OK && out.cursor,
    "native-overwrite-copy-begin");
  p->selection_cursor = out.cursor;
  uint8_t piece[4];
  REQUIRE(hvir_terminal_extract_next(p->host, p->id, p->selection_cursor, piece, sizeof(piece), &out) == HVIR_OK &&
    out.length && !out.done && out.work <= HVIR_TERMINAL_SELECTION_VISITS, "native-overwrite-first-partial-chunk");
  REQUIRE(feed(p, "\x1b[1;1Hchanged") && replies_applied(p), "selected-row-overwritten-after-chunk");
  REQUIRE(hvir_terminal_extract_next(p->host, p->id, p->selection_cursor, piece, sizeof(piece), &out) == HVIR_BUSY && out.stale,
    "native-overwrite-stale-refusal");
  REQUIRE(hvir_terminal_extract_close(p->host, p->id, p->selection_cursor) == HVIR_OK &&
    hvir_terminal_extract_close(p->host, p->id, p->selection_cursor) == HVIR_OK, "native-targeted-cancel-idempotent");
  p->selection_cursor = 0;
  REQUIRE(key(p, GHOSTTY_KEY_C, 2, 1, "c", "\x03"), "native-input-live-after-stale-copy");
  REQUIRE(feed(p, "\x1b[?1000h\x1b[?1006h") && replies_applied(p), "selection-live-tui-mode");
  hvir_terminal_input_event pointer = {.kind=HVIR_INPUT_POINTER,
    .x=(geometry.padding_left + geometry.cell_width * 2.5)/geometry.backing_scale,
    .y=(geometry.padding_top + geometry.cell_height * 2.5)/geometry.backing_scale,
    .has_button=true,.button=1,.action=1};
  REQUIRE(input(p, pointer, false, "\x1b[<0;3;3M", 9, 1), "absent-draw-context-keeps-native-tui-report");
  pointer.action = 0; pointer.selection_enabled = true; pointer.selection_screen = 0;
  pointer.selection_geometry = context.geometry_serial;
  REQUIRE(input(p, pointer, false, "\x1b[<0;3;3m", 9, 1), "stale-screen-context-keeps-native-tui-release");
  REQUIRE(selection_pointer(p, context, geometry, .25, .5, 1, 1, false, NULL) &&
    selection_pointer(p, context, geometry, 3.9, .5, -1, 1, false, NULL) &&
    selection_pointer(p, context, geometry, 3.9, .5, 0, 1, false, &serial),
    "shift-tui-override-native-selection-no-recursive-lock");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, true, "", 0, 2),
    "readonly-native-gesture-focus-cleanup-no-wire");
  REQUIRE(feed(p, "\x1b[?1000l\x1b[?1006l") && replies_applied(p), "restore-native-no-tui-reporting");
  REQUIRE(selection_command(p, HVIR_SELECTION_TERMINAL_CLEAR, &context, &out) &&
    feed(p, "\x1b]8;;https://example.com/path\x1b\\link\x1b]8;;\x1b\\") && replies_applied(p), "native-osc8-atomic-fixture");
  hvir_terminal_link_query facts;
  uint8_t uri[256]; size_t length = 0;
  double x = (geometry.padding_left + geometry.cell_width * .5) / geometry.backing_scale;
  double y = (geometry.padding_top + geometry.cell_height * .5) / geometry.backing_scale;
  REQUIRE(hvir_terminal_link_row_begin(p->host, p->id, x, y, &context, &out, &facts, uri, sizeof(uri), &length) == HVIR_OK &&
    !out.cursor && length == strlen("https://example.com/path") &&
    !memcmp(uri, "https://example.com/path", length) && facts.screen == 1, "atomic-osc8-fast-path-no-row-cursor");
  REQUIRE(selection_command(p, HVIR_SELECTION_TERMINAL_CLEAR, &context, &out) &&
    feed(p, "\xe7\x95\x8c" "e\xcc\x81 ./file.ts") && replies_applied(p), "native-physical-row-wide-fixture");
  x = (geometry.padding_left + geometry.cell_width * 1.5) / geometry.backing_scale;
  REQUIRE(hvir_terminal_link_row_begin(p->host, p->id, x, y, &context, &out, &facts, uri, sizeof(uri), &length) == HVIR_OK &&
    out.cursor && !length && out.column == 1, "native-wide-tail-row-cursor-actual-column");
  p->selection_cursor = out.cursor;
  REQUIRE(selection_drain(p, out.cursor, "\xe7\x95\x8c" "e\xcc\x81 ./file.ts", true), "native-row-exact-and-clicked-byte-head");
  REQUIRE(feed(p, "\x1b[?1049l"), "restore-primary-screen-after-selection");
  REQUIRE(selection_context(p, 0, &context, &geometry), "completed-frame-primary-screen-restored");
done:
  if (p->selection_cursor) {
    check(p, hvir_terminal_extract_close(p->host, p->id, p->selection_cursor) == HVIR_OK, "selection-owned-cursor-cleanup");
    p->selection_cursor = 0;
  }
  return !p->failed;
}

static void *run(void *data) {
  probe *p = data;
  uint8_t *paste_text = NULL, *paste_expected = NULL;
  REQUIRE(hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open-worker");
  REQUIRE(hvir_terminal_create(p->host, 800, 600, &p->id) == HVIR_OK, "create-no-pty");
  REQUIRE(feed(p, "\x1b[5n"), "silent-query-only-feed");
  REQUIRE(replies_applied(p), "silent-query-definitive-io-completion");
  uint8_t reply[32]; size_t reply_length = 0;
  REQUIRE(hvir_terminal_drain(p->host, p->id, reply, sizeof(reply), &reply_length) == HVIR_OK &&
    reply_length == 4 && !memcmp(reply, "\x1b[0n", 4), "silent-query-exact-response");
  REQUIRE(feed(p, "\x1b[6n"), "query-before-key-feed");
  REQUIRE(key(p, GHOSTTY_KEY_C, 2, 1, "c", "\x03"), "query-and-user-key-sinks-distinct");
  REQUIRE(replies_applied(p), "query-before-key-io-fence");
  REQUIRE(hvir_terminal_drain(p->host, p->id, reply, sizeof(reply), &reply_length) == HVIR_OK &&
    reply_length == 6 && !memcmp(reply, "\x1b[1;1R", 6), "query-not-captured-by-user-key");
  REQUIRE(key(p, GHOSTTY_KEY_ENTER, 0, 1, "\r", "\r"), "enter");
  REQUIRE(key(p, GHOSTTY_KEY_C, 2, 1, "c", "\x03"), "ctrl-c");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 1, "", "\x1b[A"), "normal-arrow");
  REQUIRE(feed(p, "\x1b[?1h"), "decckm-mode");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 1, "", "\x1bOA"), "decckm-arrow");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 4, 1, "", "\x1b[1;3A"), "alt-arrow");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 8, 1, "", "\x1b[1;9A"), "meta-arrow");
  hvir_terminal_input_event provider_key = {.kind=HVIR_INPUT_KEY, .key=GHOSTTY_KEY_ENTER,
    .modifiers=3, .action=1, .text=(const uint8_t *)"\r", .text_length=1, .encoding_fallback=1};
  REQUIRE(input(p, provider_key, false, "\x1b[13;6u", 7, 1), "native-per-key-csi-u-fallback");
  provider_key.encoding_fallback = 2;
  REQUIRE(input(p, provider_key, false, "\x1b[27;6;13~", 10, 1), "native-per-key-modify-other-keys-fallback");
  REQUIRE(feed(p, "\x1b[20h"), "lnm-mode");
  REQUIRE(key(p, GHOSTTY_KEY_ENTER, 0, 1, "\r", "\r\n"), "native-lnm");
  REQUIRE(feed(p, "\x1b[20l\x1b[>4;2m"), "modify-other-keys-mode");
  REQUIRE(key(p, GHOSTTY_KEY_ENTER, 3, 1, "\r", "\x1b[27;6;13~"), "modify-other-keys");
  provider_key.encoding_fallback = 1;
  REQUIRE(input(p, provider_key, false, "\x1b[27;6;13~", 10, 1), "actual-mok-overrides-csi-u-fallback");
  REQUIRE(feed(p, "\x1b[>4;0m\x1b[>3u"), "kitty-mode");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 1, "", "\x1b[1;1:1A"), "kitty-press");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_KEY, .key=GHOSTTY_KEY_ARROW_UP,
    .action=2, .encoding_fallback=2}, false, "\x1b[1;1:2A", 8, 1), "actual-kitty-events-overrides-mok-fallback");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 2, "", "\x1b[1;1:2A"), "kitty-repeat");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 0, "", "\x1b[1;1:3A"), "kitty-release");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, false, "", 0, 2), "kitty-focus-initial-reset");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS, .focused=true}, false, "", 0, 2), "kitty-focus-active");
  REQUIRE(key(p, GHOSTTY_KEY_ARROW_UP, 0, 1, "", "\x1b[1;1:1A"), "held-kitty-key");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, false,
    "\x1b[1;1:3A", 8, 2), "held-key-focus-release-explicit-control");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, false, "", 0, 2), "held-key-cleanup-idempotent");
  REQUIRE(feed(p, "\x1b[<u\x1b[?1000h\x1b[?1006h"), "mouse-sgr-mode");
  hvir_terminal_status layout;
  REQUIRE(hvir_terminal_inspect(p->host, p->id, &layout) == HVIR_OK, "mouse-layout");
  double x = layout.geometry.padding_left + layout.geometry.cell_width * 2.5;
  double y = layout.geometry.padding_top + layout.geometry.cell_height * 2.5;
  const uint32_t buttons[] = {1, 3, 2};
  const char *press[] = {"\x1b[<0;3;3M", "\x1b[<1;3;3M", "\x1b[<2;3;3M"};
  const char *release[] = {"\x1b[<0;3;3m", "\x1b[<1;3;3m", "\x1b[<2;3;3m"};
  for (size_t i = 0; i < 3; i++) {
    hvir_terminal_input_event pointer = {.kind=HVIR_INPUT_POINTER, .x=x, .y=y,
      .has_button=true, .button=buttons[i], .action=1};
    REQUIRE(input(p, pointer, false, press[i], strlen(press[i]), 1), "native-button-press");
    pointer.action = 0;
    REQUIRE(input(p, pointer, false, release[i], strlen(release[i]), 1), "native-button-release");
  }
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=x,.y=y,.delta_y=1}, false, "\x1b[<65;3;3M\x1b[<65;3;3M\x1b[<65;3;3M", 30, 1), "browser-down-native-wheel");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=x,.y=y,.delta_x=1}, false, "\x1b[<67;3;3M", 10, 1), "browser-right-native-wheel");
  REQUIRE(hvir_terminal_resize_scaled(p->host, p->id, 2, 800, 600, 1) == HVIR_OK,
    "pending-resize-before-max-wheel");
  hvir_terminal_input_result wheel;
  uint64_t wheel_started = now_ms();
  REQUIRE(hvir_terminal_input(p->host, p->id, &(hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=x,.y=y,.delta_x=32768,.delta_y=32768}, false, &wheel) == HVIR_OK, "max-accepted-wheel-with-pending-native-io-resize");
  p->wheel_ms = now_ms() - wheel_started;
  p->wheel_capacity = wheel.capacity; p->wheel_bytes = wheel.length;
  uint64_t wheel_mutation = wheel.requested_mutation;
  bool wheel_valid = wheel.capacity <= HVIR_TERMINAL_INPUT_WHEEL_MAX && wheel.length > 65536 &&
    wheel.length <= wheel.capacity && wheel.source == 1;
  hvir_terminal_input_result_free(&wheel);
  REQUIRE(wheel_valid && applied(p, wheel_mutation), "max-wheel-owned-capacity-bounded-and-io-applied");
  REQUIRE(key(p, GHOSTTY_KEY_ENTER, 0, 1, "\r", "\r"), "normal-key-after-pending-resize-and-max-wheel");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, false, "", 0, 2), "initial-focus-reset");
  REQUIRE(feed(p, "\x1b[?1004h"), "focus-reporting-mode");
  const double scales[] = {2, 1.5};
  for (size_t i = 0; i < 2; i++) {
    REQUIRE(resized(p, i + 3, scales[i], &layout), "same-state-scale-ack");
    x = (layout.geometry.padding_left + layout.geometry.cell_width * 2.5) / scales[i];
    y = (layout.geometry.padding_top + layout.geometry.cell_height * 2.5) / scales[i];
    REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS, .focused=true},
      false, "\x1b[I", 3, 2), "focus-report-control-source");
    REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_POINTER,
      .x=x,.y=y,.has_button=true,.button=1,.action=1}, false, "\x1b[<0;3;3M", 9, 1), "scaled-button-position");
    REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
      .x=x,.y=y,.delta_y=1}, false, "\x1b[<65;3;3M\x1b[<65;3;3M\x1b[<65;3;3M", 30, 1), "scaled-cached-wheel-position");
    REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS},
      false, "\x1b[O\x1b[<0;3;3m", 12, 2), "scaled-held-button-control-cleanup");
    REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS}, false, "", 0, 2), "duplicate-focus-cleanup-idempotent");
  }
  REQUIRE(feed(p, "\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?2004h"), "bracketed-paste-mode");
  size_t size = 70000;
  uint8_t *text = paste_text = malloc(size), *expected = paste_expected = malloc(size + 12);
  REQUIRE(text && expected, "paste-fixture-allocation");
  memset(text, 'p', size); memcpy(expected, "\x1b[200~", 6);
  memcpy(expected + 6, text, size); memcpy(expected + 6 + size, "\x1b[201~", 6);
  bool pasted = input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_PASTE,
    .text=text, .text_length=size}, false, (const char *)expected, size + 12, 1);
  free(text); free(expected); paste_text = paste_expected = NULL;
  REQUIRE(pasted, "dynamic-paste-above-old-64k");
  const uint8_t sanitized[] = {'x', 0, 0x1b, '\r', '\n', 0xc3, 0xa9};
  const char safe[] = "\x1b[200~x  \r\n\xc3\xa9\x1b[201~";
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_PASTE,
    .text=sanitized,.text_length=sizeof(sanitized)}, false, safe, sizeof(safe)-1, 1),
    "native-paste-nul-escape-sanitization-unicode-crlf-bracketed");
  REQUIRE(feed(p, "\x1b[?2004l\x1b[20h"), "unbracketed-lnm-paste-mode");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_PASTE,
    .text=(const uint8_t *)"a\r\n",.text_length=3}, false, "a\r\n\r\n", 5, 1), "native-unbracketed-crlf-plus-lnm");
  REQUIRE(feed(p, "\x1b[20l"), "restore-default-lnm");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_PREEDIT,
    .text=(const uint8_t *)"compose", .text_length=7}, false, "", 0, 2), "preedit-no-wire");
  hvir_terminal_input_result caret;
  REQUIRE(hvir_terminal_input(p->host, p->id,
    &(hvir_terminal_input_event){.kind=HVIR_INPUT_CARET}, false, &caret) == HVIR_OK,
    "caret-after-applied");
  bool caret_ok = caret.has_caret && caret.capacity == 0 && caret.caret_height > 0 && caret.geometry_serial == 4;
  hvir_terminal_input_result_free(&caret);
  REQUIRE(caret_ok, "caret-geometry-zero-capacity");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_PREEDIT}, false, "", 0, 2), "preedit-clear");
  REQUIRE(hvir_terminal_input(p->host, p->id,
    &(hvir_terminal_input_event){.kind=HVIR_INPUT_KEY, .key=GHOSTTY_KEY_ENTER, .action=1},
    true, &caret) == HVIR_CLOSED, "readonly-key-refused");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=30,.y=30,.delta_y=1}, true, "", 0, 1), "readonly-wheel-zero-output");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_POINTER,
    .x=30,.y=30}, true, "", 0, 1), "readonly-pointer-zero-output");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_FOCUS,
    .focused=false}, true, "", 0, 2), "readonly-focus-cleanup");
  REQUIRE(feed(p, "\x1b[?25l\x1b[2J\x1b[Hsnapshot"), "snapshot-fixture");
  hvir_terminal_status status;
  REQUIRE(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK, "snapshot-status");
  hvir_terminal_frame old, changed, restored;
  REQUIRE(completed(p, status.io_applied_mutation, &old), "baseline-completed-snapshot");
  uint64_t original = frame_hash(p, &old);
  REQUIRE(original != 0, "baseline-readable-resource");
  hvir_terminal_input_result preedit;
  REQUIRE(hvir_terminal_input(p->host, p->id, &(hvir_terminal_input_event){.kind=HVIR_INPUT_PREEDIT,
    .text=(const uint8_t *)"different", .text_length=9}, false, &preedit) == HVIR_OK,
    "held-preedit-mutation");
  uint64_t preedit_mutation = preedit.requested_mutation;
  REQUIRE(preedit.capacity == 0 && preedit.length == 0, "preedit-no-owned-result-bytes");
  hvir_terminal_input_result_free(&preedit);
  REQUIRE(applied(p, preedit_mutation), "held-preedit-io-ack-without-frame-wait");
  REQUIRE(old.snapshot_mutation < preedit_mutation && frame_hash(p, &old) == original,
    "old-held-resource-token-and-pixels-immutable");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, old.lease) == HVIR_OK, "release-old-snapshot");
  REQUIRE(completed(p, preedit_mutation, &changed), "preedit-same-snapshot-token");
  uint64_t changed_hash = frame_hash(p, &changed);
  REQUIRE(changed.kind == 2 || (changed_hash && changed_hash != original), "preedit-visible-native-pixels");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, changed.lease) == HVIR_OK, "release-preedit-snapshot");
  REQUIRE(hvir_terminal_input(p->host, p->id,
    &(hvir_terminal_input_event){.kind=HVIR_INPUT_PREEDIT}, false, &preedit) == HVIR_OK, "clear-preedit-mutation");
  uint64_t cleared = preedit.requested_mutation;
  hvir_terminal_input_result_free(&preedit);
  REQUIRE(applied(p, cleared) && completed(p, cleared, &restored), "clear-preedit-snapshot-token");
  REQUIRE(restored.kind == 2 || frame_hash(p, &restored) == original, "clear-preedit-restores-native-pixels");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, restored.lease) == HVIR_OK, "release-restored-snapshot");
  char history[6000]; size_t used = 0;
  for (unsigned i = 0; i < 100; i++) used += (size_t)snprintf(history + used,
    sizeof(history) - used, "retained-%03u\r\n", i);
  REQUIRE(feed(p, history), "readonly-history-fixture");
  REQUIRE(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK &&
    completed(p, status.io_applied_mutation, &old), "readonly-history-bottom-frame");
  original = frame_hash(p, &old);
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, old.lease) == HVIR_OK, "release-history-bottom");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=x,.y=y,.delta_y=-3}, true, "", 0, 1), "readonly-scroll-up-no-wire");
  REQUIRE(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK &&
    completed(p, status.io_applied_mutation, &changed), "readonly-scroll-up-applied-frame");
  REQUIRE(changed.kind == 2 || frame_hash(p, &changed) != original, "readonly-native-viewport-actually-scrolled");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, changed.lease) == HVIR_OK, "release-history-scrolled");
  REQUIRE(input(p, (hvir_terminal_input_event){.kind=HVIR_INPUT_WHEEL,
    .x=x,.y=y,.delta_y=3}, true, "", 0, 1), "readonly-scroll-down-no-wire");
  REQUIRE(hvir_terminal_inspect(p->host, p->id, &status) == HVIR_OK &&
    completed(p, status.io_applied_mutation, &restored), "readonly-scroll-down-applied-frame");
  REQUIRE(restored.kind == 2 || frame_hash(p, &restored) == original, "readonly-viewport-restores-bottom");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, restored.lease) == HVIR_OK, "release-readonly-bottom");
  REQUIRE(hvir_terminal_release_frame(p->host, p->id, p->held_lease) == HVIR_OK,
    "cleanup-held-resource-idempotent");
  p->held_lease = 0;
  REQUIRE(selection_proof(p), "abi8-same-parser-selection-and-link-proof");
done:
  free(paste_text); free(paste_expected);
  if (p->held_lease) check(p, hvir_terminal_release_frame(p->host, p->id, p->held_lease) == HVIR_OK,
    "cleanup-held-resource-idempotent");
  if (p->id) check(p, hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "destroy-owned-state");
  if (p->host) check(p, hvir_terminal_close(p->host) == HVIR_OK, "close-owned-host");
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  probe p = {.library=argv[1]}; pthread_t worker;
  if (pthread_create(&worker, NULL, run, &p) || pthread_join(worker, NULL)) return 2;
  printf("{\"kind\":\"native-input\",\"checks\":%u,\"passed\":%s,\"maxWheelCapacity\":%zu,\"maxWheelBytes\":%zu,\"maxWheelMs\":%" PRIu64 ",\"hardwareGpuQualified\":false}\n",
    p.checks, p.failed ? "false" : "true", p.wheel_capacity, p.wheel_bytes, p.wheel_ms);
  return p.failed;
}
