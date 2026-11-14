#include "terminal_internal.h"
#include <math.h>
#include <string.h>

/* The Surface owns the one native cursor and all tracked pins. These commands
 * use the designated caller and the same parser; there is no readback queue. */
static void selection_value(const hvir_ghostty_selection_result *in,
                            hvir_terminal_selection_result *out) {
  *out = (hvir_terminal_selection_result){
    .stale = in->stale, .has_selection = in->has_selection, .screen = in->screen, .column = in->column,
    .selection_serial = in->selection_serial, .geometry_serial = in->geometry,
    .requested_mutation = in->mutation, .cursor = in->cursor, .done = in->done,
    .visited = in->visited, .work = in->work, .length = in->written,
    .has_clicked_offset = in->has_clicked_offset, .clicked_offset = in->clicked_offset,
  };
}
static hvir_terminal_result selection_state(hvir_terminal_host *host, uint64_t id,
    const hvir_terminal_selection_context *context, terminal_state **state) {
  hvir_terminal_result code = hvir_internal_state(host, id, state, false);
  if (code) return code;
  if (!context || context->screen > 1 || !context->geometry_serial) return HVIR_INVALID;
  pthread_mutex_lock(&host->events);
  bool pending = (*state)->requested_geometry != (*state)->geometry.serial ||
    (*state)->geometry_failure_serial != 0;
  pthread_mutex_unlock(&host->events);
  return pending ? HVIR_BUSY : HVIR_OK;
}
hvir_terminal_result hvir_terminal_selection(hvir_terminal_host *host, uint64_t id,
    uint32_t action, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out) {
  if (!out) return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  if (action > HVIR_SELECTION_RESET) return HVIR_INVALID;
  terminal_state *s;
  hvir_terminal_result code = selection_state(host, id, context, &s);
  if (code) return code;
  bool mutate = action != HVIR_SELECTION_STATE;
  pthread_mutex_lock(&host->events);
  uint64_t serial = s->requested_mutation;
  bool exhausted = mutate && serial == UINT64_MAX;
  if (mutate && !exhausted) serial = ++s->requested_mutation;
  pthread_mutex_unlock(&host->events);
  if (exhausted) return HVIR_BOUND;
  hvir_ghostty_selection_result observed = {0};
  code = (hvir_terminal_result)host->external_selection(s->surface, action,
    context->screen, context->geometry_serial, mutate ? serial : 0, &observed);
  pthread_mutex_lock(&host->events);
  if (mutate && !observed.mutation) --s->requested_mutation;
  pthread_mutex_unlock(&host->events);
  selection_value(&observed, out);
  host->app_tick(host->app);
  return code;
}
static hvir_terminal_result extraction_begin(hvir_terminal_host *host, uint64_t id,
    uint64_t selection_serial, const hvir_terminal_selection_context *context,
    bool row, double x, double y, hvir_terminal_selection_result *out) {
  if (!out) return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  terminal_state *s;
  hvir_terminal_result code = selection_state(host, id, context, &s);
  if (code) return code;
  if (host->next_cursor == UINT64_MAX) return HVIR_BOUND;
  uint64_t cursor = ++host->next_cursor;
  hvir_ghostty_selection_result observed = {0};
  code = (hvir_terminal_result)host->external_extract_begin(s->surface, selection_serial,
    context->screen, context->geometry_serial, cursor, row, x, y, &observed);
  selection_value(&observed, out);
  return code;
}
hvir_terminal_result hvir_terminal_extract_begin(hvir_terminal_host *host, uint64_t id,
    uint64_t serial, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out) {
  return extraction_begin(host, id, serial, context, false, 0, 0, out);
}
hvir_terminal_result hvir_terminal_link_row_begin(hvir_terminal_host *host, uint64_t id,
    double x, double y, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out, hvir_terminal_link_query *facts,
    uint8_t *uri, size_t capacity, size_t *written) {
  if (!out || !facts || !uri || !written || !capacity || capacity > 65536 ||
      !isfinite(x) || !isfinite(y) || fabs(x) > 32768 || fabs(y) > 32768) return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  *written = 0;
  terminal_state *s;
  hvir_terminal_result code = selection_state(host, id, context, &s);
  if (code) return code;
  if (host->next_cursor == UINT64_MAX) return HVIR_BOUND;
  hvir_ghostty_selection_result observed = {0};
  hvir_ghostty_link_current_result link = {0};
  code = (hvir_terminal_result)host->external_link_row_begin(s->surface, x, y,
    context->screen, context->geometry_serial, ++host->next_cursor, &observed,
    &link, uri, capacity, written);
  selection_value(&observed, out);
  *facts = (hvir_terminal_link_query){.row = link.row, .column = link.column,
    .screen = link.screen, .sequence = link.sequence, .mutation = link.mutation,
    .geometry = link.geometry};
  return code;
}
hvir_terminal_result hvir_terminal_extract_next(hvir_terminal_host *host, uint64_t id,
    uint64_t cursor, uint8_t *bytes, size_t capacity, hvir_terminal_selection_result *out) {
  if (!out || !bytes || !cursor || capacity < 4 || capacity > HVIR_TERMINAL_SELECTION_CHUNK)
    return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  terminal_state *s;
  hvir_terminal_result code = hvir_internal_state(host, id, &s, false);
  if (code) return code;
  hvir_ghostty_selection_result observed = {0};
  code = (hvir_terminal_result)host->external_extract_next(s->surface, cursor, bytes,
    capacity, HVIR_TERMINAL_SELECTION_VISITS, &observed);
  selection_value(&observed, out);
  return code;
}
hvir_terminal_result hvir_terminal_extract_finish(hvir_terminal_host *host, uint64_t id,
    uint64_t cursor, hvir_terminal_selection_result *out) {
  if (!out || !cursor) return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  terminal_state *s;
  hvir_terminal_result code = hvir_internal_state(host, id, &s, false);
  if (code) return code;
  hvir_ghostty_selection_result observed = {0};
  code = (hvir_terminal_result)host->external_extract_finish(s->surface, cursor, &observed);
  selection_value(&observed, out);
  return code;
}
hvir_terminal_result hvir_terminal_extract_close(hvir_terminal_host *host, uint64_t id,
    uint64_t cursor) {
  hvir_terminal_result code = hvir_internal_owner(host);
  if (code) return code;
  terminal_state *s = hvir_internal_lookup(host, id);
  if (s && s->surface) host->external_extract_close(s->surface, cursor);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_link_current(hvir_terminal_host *host, uint64_t id,
    double x, double y, const hvir_terminal_selection_context *context,
    hvir_terminal_link_query *facts, uint8_t *bytes, size_t capacity, size_t *written) {
  if (!facts || !bytes || !written || !capacity || capacity > 65536 ||
      !isfinite(x) || !isfinite(y) || fabs(x) > 32768 || fabs(y) > 32768) return HVIR_INVALID;
  *written = 0;
  terminal_state *s;
  hvir_terminal_result code = selection_state(host, id, context, &s);
  if (code) return code;
  hvir_ghostty_link_current_result observed = {0};
  code = (hvir_terminal_result)host->external_link_current(s->surface, x, y,
    context->screen, context->geometry_serial, bytes, capacity, written, &observed);
  *facts = (hvir_terminal_link_query){.row = observed.row, .column = observed.column,
    .screen = observed.screen, .sequence = observed.sequence, .mutation = observed.mutation,
    .geometry = observed.geometry};
  return code;
}
