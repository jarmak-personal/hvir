#include "terminal_internal.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* A destination for this one synchronous native input operation, never an IO
 * message tag or callback replacement. Parser replies keep their separate FIFO. */
struct hvir_input_capture {
  uint8_t *bytes;
  size_t capacity, length;
  uint32_t origin;
};
bool hvir_internal_input(void *userdata, uint32_t origin, const uint8_t *bytes, size_t length) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  struct hvir_input_capture *capture = s->input_capture;
  bool valid = pthread_equal(s->host->caller, pthread_self()) && !s->closing && capture &&
    (origin == 1 || origin == 2) && (!capture->origin || capture->origin == origin) &&
    (!length || bytes) && length <= capture->capacity - capture->length;
  if (valid) {
    capture->origin = origin;
    if (length) memcpy(capture->bytes + capture->length, bytes, length);
    capture->length += length;
  } else if (!s->input_failure) s->input_failure = 1;
  pthread_mutex_unlock(&s->host->events);
  return valid;
}
void hvir_internal_mutation_applied(void *userdata, uint64_t serial) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  if (!s->closing && serial <= s->requested_mutation && serial > s->io_applied_mutation)
    s->io_applied_mutation = serial;
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
}
void hvir_terminal_input_result_free(hvir_terminal_input_result *result) {
  if (!result) return;
  free(result->data);
  *result = (hvir_terminal_input_result){0};
}
static bool coordinate(double value) { return isfinite(value) && fabs(value) <= 32768; }
static bool valid_input_text(const hvir_terminal_input_event *event) {
  return event->text_length <= 4096 &&
    (!event->text_length || !memchr(event->text, 0, event->text_length));
}
static bool valid_event(const hvir_terminal_input_event *event) {
  if (!event || event->kind < HVIR_INPUT_KEY || event->kind > HVIR_INPUT_CARET ||
      event->modifiers > 1023 || event->consumed_modifiers > 1023 ||
      (event->text_length && !event->text)) return false;
  switch (event->kind) {
    case HVIR_INPUT_KEY:
      if (event->key > 175 || event->action > 2 || event->option_as_alt > 3 || event->encoding_fallback > 2 ||
          event->unshifted_codepoint > 0x10ffff) return false;
      return valid_input_text(event);
    case HVIR_INPUT_PREEDIT:
      return valid_input_text(event);
    case HVIR_INPUT_POINTER:
      return coordinate(event->x) && coordinate(event->y) &&
        (!event->has_button || (event->button >= 1 && event->button <= 11 && event->action <= 1));
    case HVIR_INPUT_WHEEL:
      return coordinate(event->x) && coordinate(event->y) &&
        coordinate(event->delta_x) && coordinate(event->delta_y);
    default: return true;
  }
}
hvir_terminal_result hvir_terminal_input(hvir_terminal_host *host, hvir_terminal_id id,
    const hvir_terminal_input_event *event, bool read_only, hvir_terminal_input_result *out) {
  if (!out) return HVIR_INVALID;
  *out = (hvir_terminal_input_result){0};
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(host, id, &s, false);
  if (result != HVIR_OK) return result;
  if (!valid_event(event)) return HVIR_INVALID;
  if (read_only && (event->kind == HVIR_INPUT_KEY || event->kind == HVIR_INPUT_PASTE ||
      (event->kind == HVIR_INPUT_PREEDIT && event->text_length) ||
      (event->kind == HVIR_INPUT_FOCUS && event->focused))) return HVIR_CLOSED;
  bool query = event->kind == HVIR_INPUT_CARET;
  bool navigation = read_only && (event->kind == HVIR_INPUT_WHEEL || event->kind == HVIR_INPUT_POINTER);
  bool cleanup = (event->kind == HVIR_INPUT_FOCUS && !event->focused) ||
    (event->kind == HVIR_INPUT_PREEDIT && !event->text_length);
  pthread_mutex_lock(&host->events);
  bool failed = s->input_failure != 0;
  bool pending = s->requested_mutation > s->io_applied_mutation ||
    s->requested_geometry != s->geometry.serial || s->geometry_failure_serial != 0;
  pthread_mutex_unlock(&host->events);
  if (failed && !cleanup && !query && !navigation) return HVIR_FAILED;
  if (query && pending) return HVIR_BUSY;
  if (!query && s->requested_mutation == UINT64_MAX) return HVIR_BOUND;
  hvir_ghostty_input_event native = {
    .kind = event->kind, .key = event->key, .mods = event->modifiers,
    .consumed_mods = event->consumed_modifiers, .action = event->action,
    .unshifted_codepoint = event->unshifted_codepoint, .option_as_alt = event->option_as_alt,
    .encoding_fallback = event->encoding_fallback,
    .composing = event->composing, .focused = event->focused, .precision = event->precision,
    .has_button = event->has_button, .button = event->button, .x = event->x, .y = event->y,
    .delta_x = event->delta_x, .delta_y = event->delta_y,
    .text = event->text, .text_len = event->text_length,
  };
  size_t capacity = 0;
  if (!query && !host->external_input_capacity(s->surface, &native, read_only, &capacity))
    return HVIR_BOUND; /* Read-only native preflight, no mutation or emission. */
  out->capacity = capacity;
  if (event->kind != HVIR_INPUT_PASTE && capacity >
      (event->kind == HVIR_INPUT_WHEEL ? HVIR_TERMINAL_INPUT_WHEEL_MAX : HVIR_TERMINAL_INPUT_SMALL_MAX))
    return HVIR_BOUND; /* Resource admission refused before native mutation. */
  struct hvir_input_capture capture = {.capacity = capacity};
  if (capacity) {
    capture.bytes = malloc(capacity);
    if (!capture.bytes) return HVIR_NOMEM;
  }
  pthread_mutex_lock(&host->events);
  uint64_t mutation = query ? s->requested_mutation : ++s->requested_mutation;
  s->input_capture = &capture;
  pthread_mutex_unlock(&host->events);
  hvir_ghostty_input_result observed = {0};
  uint32_t native_result = host->external_input(s->surface, &native, query ? 0 : mutation, read_only, capacity, &observed);
  pthread_mutex_lock(&host->events);
  s->input_capture = NULL;
  if (native_result == 2 && !query) --s->requested_mutation;
  if (native_result == 1 && !query && !s->input_failure) s->input_failure = 2;
  failed = s->input_failure != 0;
  uint64_t geometry = s->geometry.serial;
  pthread_mutex_unlock(&host->events);
  out->requested_mutation = native_result == 2 ? 0 : mutation;
  out->source = capture.origin ? capture.origin :
    event->kind == HVIR_INPUT_FOCUS || event->kind == HVIR_INPUT_PREEDIT || query ? 2 : 1;
  if (native_result == 2) {
    out->capacity = observed.required_capacity;
    free(capture.bytes);
    return HVIR_BUSY; /* Capacity changed before any mutation; no callback/fence ran. */
  }
  if (native_result != 0 || (failed && !cleanup && !query && !navigation)) {
    free(capture.bytes);
    return HVIR_FAILED; /* State may already have mutated; never replay this call. */
  }
  out->data = capture.bytes;
  out->length = capture.length;
  out->capacity = capture.capacity;
  out->captured = observed.captured;
  out->has_caret = query;
  out->geometry_serial = geometry;
  out->caret_x = observed.x;
  out->caret_y = observed.y;
  out->caret_width = observed.width;
  out->caret_height = observed.height;
  host->app_tick(host->app);
  return HVIR_OK;
}
