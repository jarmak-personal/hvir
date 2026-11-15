#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
/* Real same-Surface config/geometry/parser/render contracts. Fixed synthetic
 * fixtures only; exported evidence contains counts and hashes, never contents. */
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  uint64_t id, sequence, serial, mutation;
  unsigned checks, cursor_policy_cases, application_cursor_overrides;
  size_t selection_foreground_pixels;
  bool failed, ligatures;
} probe;
static uint64_t now(void) {
  struct timespec value; clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static void progress(void) { const struct timespec value = {.tv_nsec = 1000000}; nanosleep(&value, NULL); }
static bool check(probe *p, bool value, const char *name) {
  p->checks++;
  if (!value) { p->failed = true; fprintf(stderr, "native-appearance:%s\n", name); }
  return value;
}
#define NEED(value, name) do { if (!check(p, (value), (name))) return false; } while (0)
static bool inspect(probe *p, hvir_terminal_status *status) {
  return hvir_terminal_inspect(p->host, p->id, status) == HVIR_OK && !status->failure;
}
static bool ready(probe *p, uint64_t geometry) {
  uint64_t deadline = now() + 5000;
  do {
    hvir_terminal_status status;
    if (!inspect(p, &status)) return false;
    if (status.io_applied_sequence >= p->sequence && status.io_applied_mutation >= p->mutation &&
        (!geometry || status.geometry.serial == geometry)) return true;
    progress();
  } while (now() < deadline);
  return false;
}
static bool feed(probe *p, const char *value) {
  return hvir_terminal_feed(p->host, p->id, ++p->sequence, (const uint8_t *)value, strlen(value)) == HVIR_OK && ready(p, 0);
}
static hvir_terminal_appearance appearance(void) {
  hvir_terminal_appearance value = {.font_family = "\"hvir Missing Font \\\"Quoted\\\"\", Menlo, monospace",
    .font_size = 13, .cursor_shape = 0, .cursor_blink = 0, .ligatures = true};
  value.colors[0] = 0x112233; value.colors[1] = 0xeeddcc;
  value.colors[2] = 0xddaa77; value.colors[3] = 0x000000;
  value.colors[4] = 0x3759bd; value.colors[5] = 0xffffff;
  for (size_t i = 6; i < 22; i++) value.colors[i] = 0x304050 + (uint32_t)i * 0x030201;
  return value;
}
static bool apply(probe *p, hvir_terminal_appearance *value) {
  NEED(hvir_terminal_appearance_set(p->host, p->id, ++p->serial, value, &p->mutation) == HVIR_OK && p->mutation,
    "typed-config-enqueued");
  NEED(ready(p, 0), "exact-config-mutation-fence");
  hvir_terminal_status status;
  NEED(inspect(p, &status) && status.applied_appearance_serial == p->serial && !status.appearance_failure_serial,
    "truthful-applied-config-serial");
  return true;
}
static bool resize(probe *p, uint64_t serial, double scale) {
  NEED(hvir_terminal_resize_scaled(p->host, p->id, serial, 640, 192, scale) == HVIR_OK && ready(p, serial),
    "fresh-geometry-ack-after-config");
  return true;
}
static bool reply(probe *p, const char *request, const char *expected) {
  uint8_t bytes[1024]; size_t length = 0;
  NEED(feed(p, request), "query-after-config-fence");
  NEED(hvir_terminal_drain(p->host, p->id, bytes, sizeof(bytes), &length) == HVIR_OK, "drain-query-reply");
  if (length != strlen(expected) || memcmp(bytes, expected, length)) {
    size_t mismatch = 0;
    while (mismatch < length && mismatch < strlen(expected) && bytes[mismatch] == (uint8_t)expected[mismatch]) mismatch++;
    fprintf(stderr, "native-appearance:protocol-expected-bytes=%zu actual-bytes=%zu first-mismatch=%zu expected-byte=%u actual-byte=%u\n",
      strlen(expected), length, mismatch, mismatch < strlen(expected) ? (uint8_t)expected[mismatch] : 0,
      mismatch < length ? bytes[mismatch] : 0);
  }
  NEED(length == strlen(expected) && !memcmp(bytes, expected, length), "exact-displayed-state-query-reply");
  return true;
}
static bool capture(probe *p, uint64_t *hash, size_t *selection_pixels) {
  uint64_t deadline = now() + 5000;
  do {
    hvir_terminal_frame frame;
    hvir_terminal_result code = hvir_terminal_take_frame(p->host, p->id, &frame);
    if (code == HVIR_OK) {
      bool current = frame.stream_sequence >= p->sequence && frame.snapshot_mutation >= p->mutation;
      bool copied = false;
      if (current) {
        size_t capacity = (size_t)frame.width * frame.height * 4, length = 0;
        uint8_t *pixels = malloc(capacity); uint32_t stride = 0;
        if (pixels) {
          copied = hvir_terminal_copy_frame(p->host, p->id, frame.lease, pixels, capacity, &length, &stride) == HVIR_OK;
          if (copied) {
            *hash = 1469598103934665603ull; *selection_pixels = 0; p->selection_foreground_pixels = 0;
            for (size_t i = 0; i < length; i++) *hash = (*hash ^ pixels[i]) * 1099511628211ull;
            for (size_t i = 0; i + 3 < length; i += 4) {
              /* The configured sRGB #3759bd is #3f58b7 in the Metal
               * export's declared Display P3 space (D50 XYZ adaptation).
               * Exact opaque bytes qualify the requested color in either space. */
              const uint8_t blue = frame.color_space == 2 ? 0xb7 : 0xbd;
              const uint8_t green = frame.color_space == 2 ? 0x58 : 0x59;
              const uint8_t red = frame.color_space == 2 ? 0x3f : 0x37;
              if (pixels[i] == blue && pixels[i+1] == green && pixels[i+2] == red) (*selection_pixels)++;
              if (pixels[i] == 0xff && pixels[i+1] == 0xff && pixels[i+2] == 0xff) p->selection_foreground_pixels++;
            }
          }
          free(pixels);
        }
      }
      NEED(hvir_terminal_release_frame(p->host, p->id, frame.lease) == HVIR_OK, "frame-lease-released");
      if (current) return check(p, copied, "actual-native-bgra-copy");
    } else NEED(code == HVIR_BUSY, "frame-only-absence-is-busy");
    progress();
  } while (now() < deadline);
  return check(p, false, "current-render-mutation-observed");
}
static bool run(probe *p) {
  NEED(hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open-designated-caller");
  NEED(hvir_terminal_create(p->host, 640, 192, &p->id) == HVIR_OK, "create-same-state");
  hvir_terminal_appearance value = appearance();
  if (!apply(p, &value) || !resize(p, 2, 1)) return false;
  hvir_terminal_status initial, large, fractional;
  NEED(inspect(p, &initial) && initial.geometry.cell_width && initial.geometry.cell_height, "measured-native-cell-metrics");
  value.font_size = 24;
  if (!apply(p, &value) || !resize(p, 3, 1)) return false;
  NEED(inspect(p, &large) && large.geometry.cell_height > initial.geometry.cell_height &&
    large.geometry.columns < initial.geometry.columns, "font-metrics-drive-grid");
  if (!resize(p, 4, 1.25)) return false;
  NEED(inspect(p, &fractional) && fractional.geometry.backing_scale == 1.25 &&
    fractional.geometry.cell_height > large.geometry.cell_height, "fractional-scale-native-metrics");
  value.font_size = 13;
  if (!apply(p, &value) || !resize(p, 5, 1)) return false;
  const char *unicode = "hvir 漢字 😀 e\xcc\x81 \xf4\x8f\xbf\xbf";
  NEED(feed(p, "\x1b[2J\x1b[H\x1b[?25l") && feed(p, unicode), "fallback-cjk-emoji-combining-missing-glyph-feed");
  uint64_t query = 0;
  NEED(hvir_terminal_query_begin(p->host, p->id, (const uint8_t *)"hvir", 4, true, &query) == HVIR_OK, "query-before-palette");
  hvir_terminal_query_status qs = {0};
  for (unsigned i = 0; i < 256 && qs.status != 2; i++)
    NEED(hvir_terminal_query_step(p->host, p->id, query, &qs) == HVIR_OK && !qs.stale, "bounded-query-progress");
  NEED(qs.status == 2 && qs.count == 1, "query-caught-up");
  hvir_terminal_selection_context context = {.screen = 0, .geometry_serial = 5};
  hvir_terminal_selection_result selected;
  NEED(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_ALL, &context, &selected) == HVIR_OK && selected.has_selection,
    "selection-before-palette");
  NEED(hvir_terminal_extract_begin(p->host, p->id, selected.selection_serial, &context, &selected) == HVIR_OK && selected.cursor,
    "live-read-before-palette");
  uint64_t cursor = selected.cursor;
  hvir_terminal_status before_palette;
  NEED(inspect(p, &before_palette), "geometry-before-palette");
  value.colors[0] = 0xe0e1e2; value.light = true;
  if (!apply(p, &value)) return false;
  hvir_terminal_status palette;
  NEED(inspect(p, &palette) && palette.geometry.serial == 5 &&
    palette.geometry.columns == before_palette.geometry.columns && palette.geometry.rows == before_palette.geometry.rows &&
    palette.geometry.cell_width == before_palette.geometry.cell_width && palette.geometry.cell_height == before_palette.geometry.cell_height,
    "palette-keeps-acknowledged-geometry");
  NEED(hvir_terminal_query_step(p->host, p->id, query, &qs) == HVIR_OK && !qs.stale && qs.count == 1,
    "palette-keeps-query-identity");
  uint8_t copied[256]; size_t offset = 0;
  do {
    NEED(hvir_terminal_extract_next(p->host, p->id, cursor, copied + offset, sizeof(copied) - offset, &selected) == HVIR_OK,
      "palette-keeps-active-read");
    offset += selected.length;
  } while (!selected.done && offset < sizeof(copied));
  NEED(selected.done && offset == strlen(unicode) && !memcmp(copied, unicode, offset), "exact-unicode-wide-combining-copy");
  NEED(hvir_terminal_extract_finish(p->host, p->id, cursor, &selected) == HVIR_OK, "palette-read-finish-certifies");
  uint64_t hash = 0; size_t pixels = 0;
  if (!capture(p, &hash, &pixels)) return false;
  NEED(pixels > 30, "configured-selection-background-actual-pixels");
  NEED(p->selection_foreground_pixels > 2, "configured-selection-foreground-actual-pixels");
  if (!reply(p, "\x1b]11;?\x1b\\\x1b]10;?\x1b\\\x1b[?996n",
      "\x1b]11;rgb:e0e0/e1e1/e2e2\x1b\\\x1b]10;rgb:eeee/dddd/cccc\x1b\\\x1b[?997;2n")) return false;
  /* External image storage0 disables the whole Kitty protocol: exact silence
   * is the upstream refusal. These fixed nonexistent names grant no media IO. */
  if (!reply(p, "\x1b_Ga=q,t=f,f=32,s=1,v=1,i=71;L3RtcC9odmlyLW5hdGl2ZS1hcHBlYXJhbmNlLW5vLXN1Y2gtZmlsZQ==\x1b\\", "") ||
      !reply(p, "\x1b_Ga=q,t=s,f=32,s=1,v=1,i=72;L2h2aXItbmF0aXZlLWFwcGVhcmFuY2Utbm8tc3VjaC1zaG0=\x1b\\", "")) return false;
  value.colors[0] = 0x223344; value.light = false;
  if (!apply(p, &value) || !reply(p, "\x1b[?996n", "\x1b[?997;1n")) return false;
  NEED(hvir_terminal_query_close(p->host, p->id, query) == HVIR_OK, "query-close");
  NEED(hvir_terminal_selection(p->host, p->id, HVIR_SELECTION_CLEAR, &context, &selected) == HVIR_OK, "clear-selection");
  NEED(feed(p, "\x1b[6 q"), "application-cursor-override");
  value.cursor_shape = 2; value.cursor_blink = 1;
  if (!apply(p, &value) || !reply(p, "\x1bP$q q\x1b\\", "\x1bP1$r6 q\x1b\\")) return false;
  p->application_cursor_overrides++;
  NEED(feed(p, "\x1b[0 q"), "application-cursor-selects-new-default");
  if (!reply(p, "\x1bP$q q\x1b\\", "\x1bP1$r3 q\x1b\\")) return false;
  value.cursor_blink = 0;
  if (!apply(p, &value)) return false;
  NEED(feed(p, "\x1b[?12l"), "terminal-policy-dec12-override");
  value.colors[1] = 0xdddddd;
  if (!apply(p, &value) || !reply(p, "\x1b[?12$p", "\x1b[?12;2$y")) return false;
  p->cursor_policy_cases++;
  value.cursor_blink = 1;
  if (!apply(p, &value)) return false;
  NEED(feed(p, "\x1b[?12l"), "forced-blinking-ignores-dec12-disable");
  if (!reply(p, "\x1b[?12$p", "\x1b[?12;1$y")) return false;
  p->cursor_policy_cases++;
  value.cursor_blink = 2;
  if (!apply(p, &value)) return false;
  NEED(feed(p, "\x1b[?12h"), "forced-steady-ignores-dec12-enable");
  if (!reply(p, "\x1b[?12$p", "\x1b[?12;2$y")) return false;
  p->cursor_policy_cases++;
  NEED(feed(p, "\x1b[5 q"), "descusr-blinking-overrides-forced-steady");
  if (!reply(p, "\x1bP$q q\x1b\\", "\x1bP1$r5 q\x1b\\")) return false;
  p->application_cursor_overrides++;
  value.font_family = "\"hvir Deliberately Missing Font\", monospace";
  value.ligatures = true;
  if (!apply(p, &value) || !resize(p, 6, 1)) return false;
  NEED(feed(p, "\x1b[2J\x1b[H\x1b[?25l=> != === -> <=>"), "embedded-fallback-ligature-fixture");
  uint64_t on = 0, off = 0;
  if (!capture(p, &on, &pixels)) return false;
  value.ligatures = false;
  if (!apply(p, &value) || !resize(p, 7, 1) || !capture(p, &off, &pixels)) return false;
  NEED(on != off, "actual-native-ligature-shaping-differs"); p->ligatures = true;
  value.font_family = "\"bad\nconfiguration\"";
  uint64_t unused = 0;
  NEED(hvir_terminal_appearance_set(p->host, p->id, p->serial + 1, &value, &unused) == HVIR_INVALID && !unused,
    "config-line-injection-refused-before-mutation");
  NEED(hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "destroy-native-state"); p->id = 0;
  NEED(hvir_terminal_close(p->host) == HVIR_OK, "close-native-host"); p->host = NULL;
  return true;
}
static const char *font_case, *font_case_family;
static void font_json_string(const char *text) {
  putchar('"');
  for (const unsigned char *at = (const unsigned char *)text; *at; at++) {
    if (*at == '"' || *at == '\\') putchar('\\');
    putchar(*at);
  }
  putchar('"');
}
/* Exactly one configured font grid in a fresh process. Existing native INFO
 * names its discovered faces; no production inspection API or transcript. */
static bool run_font_case(probe *p) {
  const char *family = font_case_family;
  bool known = !strcmp(font_case, "generic") || !strcmp(font_case, "sans") ||
    !strcmp(font_case, "system") || !strcmp(font_case, "missing") ||
    !strcmp(font_case, "mono") || !strcmp(font_case, "proportional") || !strcmp(font_case, "alias");
  NEED(known && family && *family, "known-font-case-and-owning-settings-stack");
  NEED(hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "font-case-open");
  NEED(hvir_terminal_create(p->host, 640, 192, &p->id) == HVIR_OK, "font-case-create");
  hvir_terminal_appearance value = appearance(); value.font_family = family;
  fprintf(stderr, "hvir-font-case-config-begin\n"); fflush(stderr);
  if (!apply(p, &value) || !resize(p, 2, 1)) return false;
  NEED(feed(p, "\x1b[3mItalic IW\x1b[0m"), "font-case-native-sgr-italic");
  uint64_t hash; size_t pixels;
  if (!capture(p, &hash, &pixels)) return false;
  hvir_terminal_status status;
  NEED(inspect(p, &status) && p->serial == 1 && status.applied_appearance_serial == 1 &&
    status.geometry.serial == 2, "font-case-exact-config-and-resize-ack");
  NEED(hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "font-case-destroy-native-state"); p->id = 0;
  NEED(hvir_terminal_close(p->host) == HVIR_OK, "font-case-close-native-host"); p->host = NULL;
  fprintf(stderr, "hvir-font-case-config-end\n"); fflush(stderr);
  printf("{\"kind\":\"native-font-case\",\"case\":"); font_json_string(font_case);
  printf(",\"fontFamily\":"); font_json_string(family);
  printf(",\"pid\":%llu,\"appliedAppearanceSerial\":1,\"geometrySerial\":2,\"cellWidth\":%u,\"cellHeight\":%u,\"italicFeedApplied\":true,\"currentFrameCompleted\":true,\"hardwareQualified\":false}\n",
    (unsigned long long)getpid(), status.geometry.cell_width, status.geometry.cell_height);
  return true;
}
static void *worker(void *data) {
  probe *p = data; bool passed = font_case ? run_font_case(p) : run(p);
  if (p->id) hvir_terminal_destroy(p->host, p->id);
  if (p->host) hvir_terminal_close(p->host);
  p->failed = p->failed || !passed;
  return NULL;
}
int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[2], "--font-case")) { font_case = argv[3]; font_case_family = argv[4]; }
  else if (argc != 2) return 64;
  probe p = {.library = argv[1]}; pthread_t thread;
  if (pthread_create(&thread, NULL, worker, &p) || pthread_join(thread, NULL)) return 70;
  if (!font_case) printf("{\"kind\":\"native-appearance\",\"passed\":%s,\"checks\":%u,\"ligaturePixelsDiffer\":%s,\"cursorPolicyCases\":%u,\"applicationCursorOverrides\":%u,\"hardwareQualified\":false}\n",
    p.failed ? "false" : "true", p.checks, p.ligatures ? "true" : "false", p.cursor_policy_cases, p.application_cursor_overrides);
  return p.failed ? 1 : 0;
}
