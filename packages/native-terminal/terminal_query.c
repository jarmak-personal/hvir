#include "terminal_internal.h"
#include <string.h>

/* These calls use the same designated native owner and Surface as feed/input.
 * No retained terminal bytes or identities are interpreted by the C facade. */
static hvir_terminal_result query_state(hvir_terminal_host *h, uint64_t id,
    const hvir_terminal_selection_context *context, terminal_state **s) {
  hvir_terminal_result code = hvir_internal_state(h, id, s, false);
  if (code || !context) return code;
  if (context->screen > 1 || !context->geometry_serial) return HVIR_INVALID;
  pthread_mutex_lock(&h->events);
  bool pending = (*s)->requested_geometry != (*s)->geometry.serial ||
    (*s)->geometry_failure_serial != 0;
  pthread_mutex_unlock(&h->events);
  return pending ? HVIR_BUSY : HVIR_OK;
}
hvir_terminal_result hvir_terminal_query_context(hvir_terminal_host *h, uint64_t id,
    uint32_t *screen, uint64_t *geometry) {
  if (!screen || !geometry) return HVIR_INVALID;
  *screen = 0;
  *geometry = 0;
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, NULL, &s);
  return code ? code : (hvir_terminal_result)h->external_query_context(s->surface, screen, geometry);
}
hvir_terminal_result hvir_terminal_query_begin(hvir_terminal_host *h, uint64_t id,
    const uint8_t *needle, size_t length, bool sensitive, uint64_t *query) {
  if (!query) return HVIR_INVALID;
  *query = 0;
  if (!needle || !length || length > 65536) return HVIR_INVALID;
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, NULL, &s);
  if (code) return code;
  return (hvir_terminal_result)h->external_query_begin(s->surface, needle, length, sensitive, query);
}
hvir_terminal_result hvir_terminal_query_step(hvir_terminal_host *h, uint64_t id,
    uint64_t query, hvir_terminal_query_status *out) {
  if (!out || !query) return HVIR_INVALID;
  *out = (hvir_terminal_query_status){.revision = 1};
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, NULL, &s);
  if (code) return code;
  hvir_ghostty_query_status value = {0};
  code = (hvir_terminal_result)h->external_query_step(s->surface, query,
    HVIR_TERMINAL_SELECTION_VISITS, &value);
  *out = (hvir_terminal_query_status){.query = value.query, .revision = value.revision,
    .count = value.count, .status = value.status, .stale = value.stale,
    .work = value.work, .visited = value.visited};
  return code;
}
static hvir_terminal_query_match match_value(hvir_ghostty_query_match value) {
  return (hvir_terminal_query_match){.occurrence = value.occurrence, .index = value.index,
    .screen = value.screen, .row = value.row, .column = value.column,
    .end_row = value.end_row, .end_column = value.end_column};
}
hvir_terminal_result hvir_terminal_query_page(hvir_terminal_host *h, uint64_t id,
    uint64_t query, uint64_t revision, size_t offset, hvir_terminal_query_match *matches,
    size_t capacity, hvir_terminal_query_page_result *out) {
  if (!out || !matches || !query || !revision || !capacity || capacity > HVIR_TERMINAL_QUERY_PAGE)
    return HVIR_INVALID;
  *out = (hvir_terminal_query_page_result){.revision = 1};
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, NULL, &s);
  if (code) return code;
  hvir_ghostty_query_match values[HVIR_TERMINAL_QUERY_PAGE];
  hvir_ghostty_query_page_result page = {0};
  code = (hvir_terminal_result)h->external_query_page(s->surface, query, revision,
    offset, values, capacity, &page);
  if (page.length > capacity) return HVIR_FAILED;
  for (size_t i = 0; i < page.length; i++) matches[i] = match_value(values[i]);
  *out = (hvir_terminal_query_page_result){.stale = page.stale, .revision = page.revision,
    .count = page.count, .length = page.length};
  return code;
}
hvir_terminal_result hvir_terminal_query_clear_reveal(hvir_terminal_host *h, uint64_t id,
    uint64_t query) {
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, NULL, &s);
  return code ? code : (hvir_terminal_result)h->external_query_clear_reveal(s->surface, query);
}
hvir_terminal_result hvir_terminal_query_close(hvir_terminal_host *h, uint64_t id, uint64_t query) {
  hvir_terminal_result code = hvir_internal_owner(h);
  if (code) return code;
  terminal_state *s = hvir_internal_lookup(h, id);
  return !s || !s->surface ? HVIR_OK : (hvir_terminal_result)h->external_query_close(s->surface, query);
}
static hvir_terminal_result acquire(hvir_terminal_host *h, uint64_t id,
    uint32_t kind, uint64_t first, uint64_t second, bool reveal,
    const hvir_terminal_selection_context *context, hvir_terminal_selection_result *out) {
  if (!out || !context || !first || kind > 3) return HVIR_INVALID;
  *out = (hvir_terminal_selection_result){0};
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, context, &s);
  if (code) return code;
  if (h->next_cursor == UINT64_MAX) return HVIR_BOUND;
  uint64_t cursor = ++h->next_cursor;
  hvir_ghostty_selection_result value = {0};
  if (kind == 0) {
    code = (hvir_terminal_result)h->external_query_resolve_begin(s->surface, first, second,
      reveal, context->screen, context->geometry_serial, cursor, &value);
  } else if (kind == 3) {
    code = (hvir_terminal_result)h->external_boundary_resolve_begin(s->surface, first,
      reveal, context->screen, context->geometry_serial, cursor, &value);
  } else {
    code = (hvir_terminal_result)h->external_range_begin(s->surface, kind, first, second,
      context->screen, context->geometry_serial, cursor, &value);
  }
  hvir_internal_selection_value(&value, out);
  return code;
}
hvir_terminal_result hvir_terminal_query_resolve_begin(hvir_terminal_host *h, uint64_t id,
    uint64_t query, uint64_t occurrence, bool reveal, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out) {
  if (!occurrence) return HVIR_INVALID;
  return acquire(h, id, 0, query, occurrence, reveal, context, out);
}
hvir_terminal_result hvir_terminal_range_begin(hvir_terminal_host *h, uint64_t id,
    uint32_t kind, uint64_t first, uint64_t second, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out) {
  if ((kind != 1 && kind != 2) || (kind == 1 && !second)) return HVIR_INVALID;
  return acquire(h, id, kind, first, second, false, context, out);
}
hvir_terminal_result hvir_terminal_boundary_capture_end(hvir_terminal_host *h, uint64_t id,
    const hvir_terminal_selection_context *context, hvir_terminal_boundary *out) {
  if (!out || !context) return HVIR_INVALID;
  *out = (hvir_terminal_boundary){0};
  terminal_state *s;
  hvir_terminal_result code = query_state(h, id, context, &s);
  if (code) return code;
  hvir_ghostty_boundary value = {0};
  code = (hvir_terminal_result)h->external_boundary_capture_end(s->surface,
    context->screen, context->geometry_serial, &value);
  *out = (hvir_terminal_boundary){.boundary = value.boundary, .screen = value.screen,
    .row = value.row, .column = value.column, .stale = value.stale};
  return code;
}
hvir_terminal_result hvir_terminal_boundary_resolve_begin(hvir_terminal_host *h, uint64_t id,
    uint64_t boundary, bool reveal, const hvir_terminal_selection_context *context,
    hvir_terminal_selection_result *out) {
  return acquire(h, id, 3, boundary, 0, reveal, context, out);
}
hvir_terminal_result hvir_terminal_boundary_close(hvir_terminal_host *h, uint64_t id, uint64_t token) {
  hvir_terminal_result code = hvir_internal_owner(h);
  if (code) return code;
  terminal_state *s = hvir_internal_lookup(h, id);
  return !s || !s->surface ? HVIR_OK : (hvir_terminal_result)h->external_boundary_close(s->surface, token);
}
