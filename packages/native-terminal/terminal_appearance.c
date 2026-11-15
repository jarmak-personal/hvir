#include "terminal_internal.h"
#include <ctype.h>
#include <math.h>
#include <string.h>

/* Parse only the existing CSS family-stack value. Quotes/escapes are data and
 * cannot introduce native config keys. Native discovery owns fallback/glyphs. */
static bool families(const char *input, char storage[1025], const char *out[32], size_t *count) {
  size_t length = strnlen(input, 1025), used = 0;
  if (!length || length > 1024) return false;
  *count = 0;
  for (size_t i = 0; i < length;) {
    if (*count == 32) return false;
    while (i < length && input[i] == ' ') i++;
    size_t start = used;
    char quote = 0;
    if (i < length && (input[i] == '\'' || input[i] == '"')) quote = input[i++];
    bool closed = !quote;
    while (i < length) {
      unsigned char c = (unsigned char)input[i++];
      if (c < 32 || c == 127) return false;
      if (quote && c == (unsigned char)quote) { closed = true; break; }
      if (!quote && c == ',') { i--; break; }
      if (c == '\\') {
        if (i == length) return false;
        c = (unsigned char)input[i++];
        if (c < 32 || c == 127) return false;
      }
      storage[used++] = (char)c;
    }
    if (!closed) return false;
    if (!quote) while (used > start && storage[used - 1] == ' ') used--;
    while (i < length && input[i] == ' ') i++;
    if (i < length && input[i] != ',') return false;
    if (used == start) return false;
    storage[used++] = 0;
    out[(*count)++] = storage + start;
    if (i < length) { i++; if (i == length) return false; }
  }
  return *count != 0;
}

hvir_terminal_result hvir_terminal_appearance_set(hvir_terminal_host *host, hvir_terminal_id id,
    uint64_t serial, const hvir_terminal_appearance *value, uint64_t *requested_mutation) {
  if (!value || !value->font_family || !requested_mutation) return HVIR_INVALID;
  *requested_mutation = 0;
  terminal_state *state;
  hvir_terminal_result result = hvir_internal_state(host, id, &state, false);
  if (result) return result;
  if (!serial || serial <= state->appearance_serial || !isfinite(value->font_size) ||
      value->font_size < 1 || value->font_size > 255 || value->cursor_shape > 3 ||
      value->cursor_blink > 2) return HVIR_INVALID;
  char storage[1025]; const char *names[32]; size_t count;
  if (!families(value->font_family, storage, names, &count)) return HVIR_INVALID;
  for (size_t i = 0; i < 22; i++) if (value->colors[i] > 0xffffff) return HVIR_INVALID;
  bool typography = strcmp(value->font_family, state->appearance_font_family) ||
    value->font_size != state->appearance_font_size || value->ligatures != state->appearance_ligatures;
  hvir_ghostty_appearance native = {.families = names, .family_count = count,
    .font_size_pixels = value->font_size, .cursor_shape = value->cursor_shape,
    .cursor_blink = value->cursor_blink, .ligatures = value->ligatures, .light = value->light};
  memcpy(native.colors, value->colors, sizeof(native.colors));
  pthread_mutex_lock(&host->events);
  if (state->requested_mutation == UINT64_MAX) { pthread_mutex_unlock(&host->events); return HVIR_BOUND; }
  uint64_t mutation = ++state->requested_mutation;
  state->appearance_serial = serial;
  state->appearance_mutation = mutation;
  pthread_mutex_unlock(&host->events);
  *requested_mutation = mutation;
  if (!host->external_appearance(state->surface, &native, typography, mutation)) {
    pthread_mutex_lock(&host->events);
    state->appearance_failure_serial = serial;
    /* A strict native reload can fail after mutating geometry or one config
     * owner. Revoke the state rather than report a healthy mixed appearance. */
    if (!state->failure) state->failure = HVIR_FAILED;
    pthread_mutex_unlock(&host->events);
    return HVIR_FAILED;
  }
  memcpy(state->appearance_font_family, value->font_family, strlen(value->font_family) + 1);
  state->appearance_font_size = value->font_size;
  state->appearance_ligatures = value->ligatures;
  return HVIR_OK;
}
