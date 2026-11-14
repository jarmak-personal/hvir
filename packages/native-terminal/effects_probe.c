#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include <inttypes.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
/* Fixed protocol fixtures against the same real Terminal. No payload is logged. */
typedef struct {
  const char *library;
  hvir_terminal_host *host;
  hvir_terminal_id id;
  uint64_t sequence, last_serial;
  unsigned checks;
  bool failed;
} probe;
static uint64_t now_ms(void) {
  struct timespec value; clock_gettime(CLOCK_MONOTONIC, &value);
  return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static bool check(probe *p, bool value, const char *name) {
  p->checks++;
  if (!value) { p->failed = true; fprintf(stderr, "native-effects: %s\n", name); }
  return value;
}
#define REQUIRE(value, name) do { if (!check(p, (value), (name))) goto done; } while (0)
static bool feed_bytes(probe *p, const uint8_t *bytes, size_t length, size_t chunk) {
  for (size_t start = 0; start < length; start += chunk) {
    size_t part = length - start; if (part > chunk) part = chunk;
    if (hvir_terminal_feed(p->host, p->id, ++p->sequence, bytes + start, part) != HVIR_OK) return false;
  }
  return true;
}
static bool feed(probe *p, const char *text) {
  return feed_bytes(p, (const uint8_t *)text, strlen(text), 4093);
}
static bool applied(probe *p, hvir_terminal_status *status) {
  const uint64_t deadline = now_ms() + 5000;
  do {
    if (hvir_terminal_inspect(p->host, p->id, status) != HVIR_OK || status->failure) return false;
    if (status->io_applied_sequence >= p->sequence) return true;
    const struct timespec pause = {.tv_nsec = 1000000}; nanosleep(&pause, NULL);
  } while (now_ms() < deadline);
  return false;
}
static bool event(probe *p, uint32_t kind, hvir_terminal_event *out) {
  for (size_t i = 0; i < 131; i++) {
    hvir_terminal_result result = hvir_terminal_next_event(p->host, p->id, out);
    if (result == HVIR_BUSY) return false;
    if (!check(p, result == HVIR_OK && !out->truncated && out->sequence <= p->sequence &&
      out->event_serial > p->last_serial, "copied-event-provenance")) return false;
    p->last_serial = out->event_serial;
    if (out->kind == kind) return true;
  }
  return false;
}
static bool drain(probe *p) {
  hvir_terminal_event out;
  for (size_t i = 0; i <= 131; i++) {
    hvir_terminal_result result = hvir_terminal_next_event(p->host, p->id, &out);
    if (result == HVIR_BUSY) return true;
    if (result != HVIR_OK || i == 131) return false;
    p->last_serial = out.event_serial;
  }
  return false;
}
static bool exact(const uint8_t *bytes, size_t length, const char *text) {
  return length == strlen(text) && !memcmp(bytes, text, length);
}
static void *run(void *userdata) {
  probe *p = userdata;
  uint8_t *clipboard = NULL;
  hvir_terminal_event *out = malloc(sizeof(*out));
  REQUIRE(out != NULL, "allocate-probe-record");
  REQUIRE(hvir_terminal_open(p->library, NULL, &p->host) == HVIR_OK, "open-on-nonmain-caller");
  REQUIRE(hvir_terminal_create(p->host, 800, 600, &p->id) == HVIR_OK, "create-same-state");
  REQUIRE(drain(p), "drain-startup");
  REQUIRE(feed(p, "\x1b]0;split") && feed(p, " title\x07"), "split-title-sequence");
  REQUIRE(event(p, 1, out) && exact(out->data, out->length, "split title") &&
    out->sequence == p->sequence, "title-causal-completing-feed");
  char long_title[610]; memset(long_title, 't', sizeof(long_title));
  memcpy(long_title, "\x1b]2;", 4); long_title[604] = 7; long_title[605] = 0;
  REQUIRE(feed(p, long_title) && event(p, 1, out) && out->length == 600,
    "title-not-gui256-truncated");
  REQUIRE(feed(p, "\x1b]7;file://remote-fixture/tmp/a%20b\x07") && event(p, 2, out) &&
    exact(out->data, out->length, "file://remote-fixture/tmp/a%20b"), "remote-cwd-uri-preserved");
  char bells[2001]; memset(bells, 7, 2000); bells[2000] = 0;
  REQUIRE(feed(p, bells) && event(p, 3, out), "bell-flood-coalesces");
  hvir_terminal_status status;
  REQUIRE(applied(p, &status) && !status.failure, "bell-flood-parser-alive");
  REQUIRE(feed(p, "\x1b]9;notice\x07\x1b]777;notify;title;body\x07"), "notification-fixture");
  REQUIRE(event(p, 4, out) && out->action == 0 && exact(out->extra, out->extra_length, "notice"),
    "osc9-origin-preserved");
  REQUIRE(event(p, 4, out) && out->action == 1 && exact(out->data, out->length, "title") &&
    exact(out->extra, out->extra_length, "body"), "osc777-origin-preserved");
  REQUIRE(feed(p, "\x1b]9;4;1;42\x07") && event(p, 10, out) && out->action == 1 && out->row == 42,
    "typed-progress-observation");
  const size_t encoded = 65536;
  clipboard = malloc(encoded + 16); REQUIRE(clipboard != NULL, "allocate-fixed-clipboard-fixture");
  memcpy(clipboard, "\x1b]52;pc;", 8); memset(clipboard + 8, 'A', encoded); clipboard[encoded + 8] = 7;
  REQUIRE(feed_bytes(p, clipboard, encoded + 9, 4093), "full-clipboard-split-feed");
  REQUIRE(event(p, 5, out) && out->action == 1 && out->length == encoded &&
    exact(out->extra, out->extra_length, "pc"), "full-encoded-clipboard-selection");
  bool copied = true;
  for (size_t i = 0; i < out->length; i++) if (out->data[i] != 'A') copied = false;
  REQUIRE(copied, "clipboard-copied-exactly");
  hvir_terminal_effect_status oversized_before, oversized_after;
  REQUIRE(hvir_terminal_effects_status(p->host, p->id, &oversized_before) == HVIR_OK, "before-oversized-effect");
  memset(clipboard + 8, 'A', encoded + 4); clipboard[encoded + 12] = 7;
  REQUIRE(feed_bytes(p, clipboard, encoded + 13, 4093) &&
    hvir_terminal_effects_status(p->host, p->id, &oversized_after) == HVIR_OK &&
    oversized_after.dropped_effects > oversized_before.dropped_effects && !event(p, 5, out),
    "oversized-clipboard-refused-without-truncation");
  REQUIRE(feed(p, "\x1b]52;c;?\x07\x1b]1337;Copy=:QQ==\x07\x1b]5522;type=read\x07"),
    "clipboard-read-newprotocol-refusal");
  REQUIRE(!event(p, 5, out) && applied(p, &status), "no-clipboard-read-or-newprotocol-effect");
  uint8_t replies[1024]; size_t length = 0;
  REQUIRE(hvir_terminal_drain(p->host, p->id, replies, sizeof(replies), &length) == HVIR_OK &&
    length == 0, "no-clipboard-read-reply");
  REQUIRE(feed(p, "\x1b[2J\x1b[H\x1b]133;A\x07prompt\x1b]133;B\x07" "cmd\x1b]133;C\x07out\x1b]133;D;0\x07"),
    "semantic-fixture");
  REQUIRE(event(p, 6, out) && out->action == 1 && out->screen == 0, "native-prompt-boundary");
  REQUIRE(event(p, 6, out) && out->action == 4 && out->column == 6, "native-input-boundary");
  REQUIRE(event(p, 6, out) && out->action == 6 && out->column == 9, "native-output-boundary");
  REQUIRE(event(p, 6, out) && out->action == 7 && out->column == 12 &&
    exact(out->data, out->length, "0"), "native-command-end-options");
  REQUIRE(feed(p, "\x1b[?1049h\x1b[H\x1b]133;A\x07") && event(p, 8, out) && out->screen == 1 &&
    event(p, 6, out) && out->screen == 1, "alternate-screen-semantic-provenance");
  REQUIRE(feed(p, "\x1b[?1049l") && drain(p), "restore-primary");
  REQUIRE(feed(p, "\x1b[2J\x1b[H\x1b]8;;https://example.test/path\x1b\\link\x1b]8;;\x1b\\"), "osc8-fixture");
  REQUIRE(applied(p, &status), "osc8-io-applied");
  hvir_terminal_link_query query = {.row=0, .column=1, .screen=0, .sequence=p->sequence,
    .mutation=status.io_applied_mutation, .geometry=status.geometry.serial};
  REQUIRE(hvir_terminal_link(p->host, p->id, &query, replies, sizeof(replies), &length) == HVIR_OK &&
    exact(replies, length, "https://example.test/path"), "same-state-osc8-viewport-readback");
  query.sequence--;
  REQUIRE(hvir_terminal_link(p->host, p->id, &query, replies, sizeof(replies), &length) == HVIR_BUSY,
    "stale-link-snapshot-refused");
  const uint8_t invalid_link[] = {27,'[','H',27,']','8',';',';',255,7,'b','a','d',27,']','8',';',';',7};
  REQUIRE(feed_bytes(p, invalid_link, sizeof(invalid_link), 1) && applied(p, &status),
    "invalid-osc8-fixture");
  query.sequence = p->sequence; query.column = 0;
  query.mutation = status.io_applied_mutation; query.geometry = status.geometry.serial;
  REQUIRE(hvir_terminal_link(p->host, p->id, &query, replies, sizeof(replies), &length) == HVIR_OK &&
    length == 0 && !status.failure, "invalid-osc8-uri-refused-without-native-loss");
  REQUIRE(feed(p, "\x1b]4;1;#123456\x1b\\\x1b]4;1;?\x1b\\") && applied(p, &status), "palette-query-fixture");
  REQUIRE(hvir_terminal_drain(p->host, p->id, replies, sizeof(replies), &length) == HVIR_OK &&
    exact(replies, length, "\x1b]4;1;rgb:1212/3434/5656\x1b\\"), "same-terminal-palette-query-reply");
  REQUIRE(event(p, 7, out) && out->action == 0 && out->screen == 4 && out->row == 0 &&
    out->column == 1 && out->length == 3 && out->data[0] == 0x12 && out->data[1] == 0x34 &&
    out->data[2] == 0x56, "binary-palette-request-metadata");
  REQUIRE(drain(p), "drain-palette-query-observation");
  REQUIRE(feed(p, "\x1b]10;#aabbcc\x1b\\\x1b]10;?\x1b\\") && applied(p, &status) &&
    hvir_terminal_drain(p->host, p->id, replies, sizeof(replies), &length) == HVIR_OK &&
    exact(replies, length, "\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\"), "native-dynamic-foreground-query");
  REQUIRE(feed(p, "\x1b[?996n") && applied(p, &status) &&
    hvir_terminal_drain(p->host, p->id, replies, sizeof(replies), &length) == HVIR_OK &&
    exact(replies, length, "\x1b[?997;2n"), "native-configured-default-light-theme-query");
  REQUIRE(drain(p), "drain-dynamic-palette-observation");
  hvir_terminal_effect_status before, after;
  REQUIRE(hvir_terminal_effects_status(p->host, p->id, &before) == HVIR_OK, "effect-status-before-invalid");
  const uint8_t invalid[] = {27,']','0',';',255,7};
  REQUIRE(feed_bytes(p, invalid, sizeof(invalid), 1) && applied(p, &status), "malformed-utf8-osc-parser-alive");
  REQUIRE(!event(p, 1, out), "invalid-title-refused-by-native-parser");
  const uint8_t invalid_cwd[] = {27,']','7',';','f','i','l','e',':','/','/',255,7};
  REQUIRE(feed_bytes(p, invalid_cwd, sizeof(invalid_cwd), 1), "malformed-cwd-fixture");
  const uint8_t invalid_semantic[] = {27,']','1','3','3',';','B',';',255,7};
  const uint8_t invalid_clipboard[] = {27,']','5','2',';','c',';',255,7};
  REQUIRE(feed_bytes(p, invalid_semantic, sizeof(invalid_semantic), 2) &&
    feed_bytes(p, invalid_clipboard, sizeof(invalid_clipboard), 2), "malformed-semantic-clipboard-fixtures");
  REQUIRE(hvir_terminal_effects_status(p->host, p->id, &after) == HVIR_OK &&
    after.dropped_effects >= before.dropped_effects + 3 && after.semantic_generation > before.semantic_generation,
    "invalid-text-observable-refusal");
  REQUIRE(drain(p), "drain-before-semantic-flood");
  for (size_t n = 0; n < 140; n++) REQUIRE(feed(p, "\x1b]133;B\x07"), "semantic-burst-feed");
  REQUIRE(hvir_terminal_effects_status(p->host, p->id, &after) == HVIR_OK &&
    after.dropped_effects > before.dropped_effects + 3 && applied(p, &status) && !status.failure,
    "semantic-flood-sticky-gap-parser-alive");
  REQUIRE(drain(p), "finite-semantic-flood-drain");
  memcpy(clipboard, "\x1b]7;", 4); memset(clipboard + 4, 'a', 5000); clipboard[5004] = 7;
  REQUIRE(feed_bytes(p, clipboard, 5005, 4093) && !event(p, 2, out) && applied(p, &status) &&
    !status.failure, "oversized-osc7-refused-at-existing-parser-capture-bound");
  REQUIRE(feed(p, "\x1b" "c") && event(p, 8, out) && out->action == 1, "full-reset-observation");
  REQUIRE(hvir_terminal_effects_status(p->host, p->id, &after) == HVIR_OK &&
    after.semantic_generation > before.semantic_generation, "reset-sticky-semantic-generation");
  REQUIRE(feed(p, "healthy\x1b[5n") && applied(p, &status) && !status.failure, "parser-reply-progress-after-refusal");
  REQUIRE(hvir_terminal_drain(p->host, p->id, replies, sizeof(replies), &length) == HVIR_OK &&
    exact(replies, length, "\x1b[0n"), "silent-query-io-fence-retained");
  hvir_terminal_input_event key = {.kind=HVIR_INPUT_KEY, .action=1, .text=(const uint8_t *)"x", .text_length=1};
  hvir_terminal_input_result input;
  REQUIRE(hvir_terminal_input(p->host, p->id, &key, false, &input) == HVIR_OK, "input-after-effect-refusal");
  bool input_ok = input.length == 1 && input.data[0] == 'x'; hvir_terminal_input_result_free(&input);
  REQUIRE(input_ok, "user-input-still-exact");
done:
  free(clipboard); free(out);
  if (p->id) check(p, hvir_terminal_destroy(p->host, p->id) == HVIR_OK, "destroy-owned-native-state");
  if (p->host) check(p, hvir_terminal_close(p->host) == HVIR_OK, "close-owned-native-host");
  return NULL;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  probe p = {.library=argv[1]}; pthread_t worker;
  if (pthread_create(&worker, NULL, run, &p) || pthread_join(worker, NULL)) return 2;
  printf("{\"kind\":\"native-effects\",\"checks\":%u,\"passed\":%s,\"hardwareGpuQualified\":false}\n",
    p.checks, p.failed ? "false" : "true");
  return p.failed ? 1 : 0;
}
