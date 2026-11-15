#include "host_query_binding.h"

/* Mechanical NAPI boundary only. The C facade owns all query, occurrence,
 * boundary and extraction lifetimes on the existing designated caller. */
#define JS_SAFE_INTEGER UINT64_C(9007199254740991)
typedef enum {
  QUERY_BEGIN, QUERY_STEP, QUERY_PAGE, QUERY_RESOLVE_BEGIN, QUERY_CLEAR_REVEAL,
  QUERY_CLOSE, RANGE_BEGIN, BOUNDARY_CAPTURE_END, BOUNDARY_RESOLVE_BEGIN, BOUNDARY_CLOSE, QUERY_CONTEXT
} query_operation;

static bool metadata_error(napi_env env) {
  napi_throw_error(env, NULL, "Invalid native retained query metadata");
  return false;
}
static napi_value count_value(napi_env env, uint64_t value) {
  if (value > JS_SAFE_INTEGER) { metadata_error(env); return NULL; }
  return real(env, (double)value);
}
static bool index_argument(napi_env env, napi_value value, size_t *out) {
  napi_valuetype type;
  double numeric;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &numeric) != napi_ok ||
      !(numeric >= 0 && numeric <= JS_SAFE_INTEGER && numeric <= SIZE_MAX) ||
      (double)(size_t)numeric != numeric) {
    bad_argument(env); return false;
  }
  *out = (size_t)numeric;
  return true;
}
static bool bool_argument(napi_env env, napi_value value, bool *out) {
  if (napi_get_value_bool(env, value, out) == napi_ok) return true;
  bad_argument(env); return false;
}
static napi_value property(napi_env env, napi_value value, const char *key) {
  napi_value result;
  return checked(env, napi_get_named_property(env, value, key, &result)) ? result : NULL;
}
static bool big_property(napi_env env, napi_value object, const char *key, uint64_t *out) {
  napi_value value = property(env, object, key);
  return value && u64(env, value, out);
}
static bool range_keys(napi_env env, napi_value value, bool match) {
  napi_value names;
  uint32_t length = 0;
  if (!checked(env, napi_get_property_names(env, value, &names)) ||
      !checked(env, napi_get_array_length(env, names, &length)) || length > 3) return false;
  for (uint32_t i = 0; i < length; i++) {
    napi_value name;
    if (!checked(env, napi_get_element(env, names, i, &name))) return false;
    char *key = text(env, name, 16);
    if (!key) return false;
    bool allowed = !strcmp(key, "kind") || !strcmp(key, match ? "query" : "start") ||
      !strcmp(key, match ? "occurrence" : "end");
    free(key);
    if (!allowed) { bad_argument(env); return false; }
  }
  return true;
}
static napi_value query_result(napi_env env, hvir_terminal_result code, bool stale) {
  napi_value value = outcome(env, code);
  return put(env, value, "stale", boolean(env, stale)) ? value : NULL;
}
static napi_value match_value(napi_env env, const hvir_terminal_query_match *match) {
  if (!match->occurrence || match->screen != 0) { metadata_error(env); return NULL; }
  napi_value value = object(env);
  return put(env, value, "occurrence", big(env, match->occurrence)) &&
    put(env, value, "index", count_value(env, match->index)) &&
    put(env, value, "screen", number(env, match->screen)) &&
    put(env, value, "row", number(env, match->row)) &&
    put(env, value, "column", number(env, match->column)) &&
    put(env, value, "endRow", number(env, match->end_row)) &&
    put(env, value, "endColumn", number(env, match->end_column)) ? value : NULL;
}
static bool put_boundary(napi_env env, napi_value value, const hvir_terminal_boundary *boundary) {
  if (!boundary->boundary || boundary->screen > 1) return metadata_error(env);
  return put(env, value, "boundary", big(env, boundary->boundary)) &&
    put(env, value, "screen", number(env, boundary->screen)) &&
    put(env, value, "row", number(env, boundary->row)) &&
    put(env, value, "column", number(env, boundary->column));
}
bool hvir_query_binding_resolution(napi_env env, napi_value value,
    const hvir_terminal_selection_result *result) {
  if (!result->resolution_kind) return true;
  if (result->resolution_kind > 2) return metadata_error(env);
  if (!put(env, value, "resolved", boolean(env, result->resolved)) ||
      !put(env, value, "revealed", boolean(env, result->revealed))) return false;
  if (!result->resolved) return true;
  if (result->resolution_kind == 1)
    return put(env, value, "match", match_value(env, &result->match));
  napi_value boundary = object(env);
  return put_boundary(env, boundary, &result->boundary) && put(env, value, "boundary", boundary);
}
static napi_value cursor_value(napi_env env, hvir_terminal_host *host, uint64_t id,
    hvir_terminal_result code, const hvir_terminal_selection_result *observed) {
  napi_value result = hvir_query_binding_selection(env, code, observed);
  if (!put(env, result, "cursor", big(env, observed->cursor))) {
    if (observed->cursor) hvir_terminal_extract_close(host, id, observed->cursor);
    return NULL;
  }
  return result;
}
static napi_value begin_query(napi_env env, hvir_terminal_host *host, uint64_t id,
    napi_value needle_value, napi_value sensitive_value) {
  size_t length = 0, written = 0;
  bool sensitive;
  if (!bool_argument(env, sensitive_value, &sensitive) ||
      napi_get_value_string_utf8(env, needle_value, NULL, 0, &length) != napi_ok ||
      !length || length > HVIR_TERMINAL_FEED_MAX) {
    bad_argument(env); return NULL;
  }
  /* Literal text may contain NUL; byte length, not strlen, is authoritative. */
  uint8_t needle[HVIR_TERMINAL_FEED_MAX + 1];
  if (!checked(env, napi_get_value_string_utf8(env, needle_value, (char *)needle,
      sizeof(needle), &written)) || written != length) return NULL;
  uint64_t query = 0;
  hvir_terminal_result code = hvir_terminal_query_begin(host, id, needle, length, sensitive, &query);
  napi_value value = query_result(env, code, false);
  if (!value || (query && !put(env, value, "query", big(env, query)))) {
    if (query) hvir_terminal_query_close(host, id, query);
    return NULL;
  }
  return value;
}
static napi_value step_query(napi_env env, hvir_terminal_host *host, uint64_t id, uint64_t query) {
  hvir_terminal_query_status status = {0};
  hvir_terminal_result code = hvir_terminal_query_step(host, id, query, &status);
  if (status.status > 2 || status.work > HVIR_TERMINAL_SELECTION_VISITS ||
      status.visited > HVIR_TERMINAL_SELECTION_VISITS) {
    metadata_error(env); return NULL;
  }
  napi_value value = query_result(env, code, status.stale);
  return put(env, value, "query", big(env, status.query)) &&
    put(env, value, "revision", big(env, status.revision)) &&
    put(env, value, "count", count_value(env, status.count)) &&
    put(env, value, "status", number(env, status.status)) &&
    put(env, value, "work", number(env, (uint32_t)status.work)) &&
    put(env, value, "visited", number(env, (uint32_t)status.visited)) ? value : NULL;
}
static napi_value page_query(napi_env env, hvir_terminal_host *host, uint64_t id,
    uint64_t query, napi_value revision_value, napi_value offset_value, napi_value capacity_value) {
  uint64_t revision;
  size_t offset, capacity;
  if (!u64(env, revision_value, &revision) || !index_argument(env, offset_value, &offset) ||
      !index_argument(env, capacity_value, &capacity)) return NULL;
  if (!capacity || capacity > HVIR_TERMINAL_QUERY_PAGE) { bad_argument(env); return NULL; }
  hvir_terminal_query_match matches[HVIR_TERMINAL_QUERY_PAGE];
  hvir_terminal_query_page_result page = {0};
  hvir_terminal_result code = hvir_terminal_query_page(host, id, query, revision,
    offset, matches, capacity, &page);
  if (page.length > capacity || (code != HVIR_OK && page.length)) {
    metadata_error(env); return NULL;
  }
  napi_value value = query_result(env, code, page.stale), results;
  if (!value || !checked(env, napi_create_array_with_length(env, page.length, &results))) return NULL;
  for (size_t i = 0; i < page.length; i++) {
    napi_value match = match_value(env, &matches[i]);
    if (!match || !checked(env, napi_set_element(env, results, (uint32_t)i, match))) return NULL;
  }
  return put(env, value, "revision", big(env, page.revision)) &&
    put(env, value, "count", count_value(env, page.count)) &&
    put(env, value, "results", results) ? value : NULL;
}
static napi_value range_begin(napi_env env, hvir_terminal_host *host, uint64_t id,
    napi_value range, napi_value context_value) {
  hvir_terminal_selection_context context;
  if (!hvir_query_binding_context(env, context_value, &context)) return NULL;
  napi_value kind = property(env, range, "kind");
  char *name = kind ? text(env, kind, 8) : NULL;
  if (!name) return NULL;
  bool match = !strcmp(name, "match"), semantic = !strcmp(name, "semantic");
  free(name);
  if ((!match && !semantic) || !range_keys(env, range, match)) { bad_argument(env); return NULL; }
  uint64_t first, second = 0;
  if (!big_property(env, range, match ? "query" : "start", &first)) return NULL;
  if (match) {
    if (!big_property(env, range, "occurrence", &second)) return NULL;
  } else {
    napi_value end = property(env, range, "end");
    napi_valuetype type;
    if (!end || !checked(env, napi_typeof(env, end, &type))) return NULL;
    if (type != napi_undefined && !u64(env, end, &second)) return NULL;
  }
  hvir_terminal_selection_result observed = {0};
  hvir_terminal_result code = hvir_terminal_range_begin(host, id, match ? 1 : 2,
    first, second, &context, &observed);
  return cursor_value(env, host, id, code, &observed);
}
static napi_value invoke_query(napi_env env, napi_callback_info info) {
  napi_value args[7];
  size_t argc = 7;
  void *data = NULL;
  if (!checked(env, napi_get_cb_info(env, info, &argc, args, NULL, &data))) return NULL;
  query_operation op = (query_operation)(uintptr_t)data;
  static const size_t arity[] = {4, 3, 6, 6, 3, 3, 4, 3, 5, 3, 2};
  if ((size_t)op >= sizeof(arity) / sizeof(arity[0]) || argc != arity[op]) {
    bad_argument(env); return NULL;
  }
  hvir_terminal_host *host;
  uint64_t id, token;
  if (!hvir_query_binding_host(env, args[0], &host) || !u64(env, args[1], &id)) return NULL;
  if (op == QUERY_CONTEXT) {
    uint32_t screen = 0; uint64_t geometry = 0;
    hvir_terminal_result code = hvir_terminal_query_context(host, id, &screen, &geometry);
    if (screen > 1) { metadata_error(env); return NULL; }
    napi_value value = query_result(env, code, false);
    return put(env, value, "screen", number(env, screen)) &&
      put(env, value, "geometrySerial", big(env, geometry)) ? value : NULL;
  }
  if (op == QUERY_BEGIN) return begin_query(env, host, id, args[2], args[3]);
  if (op == RANGE_BEGIN) return range_begin(env, host, id, args[2], args[3]);
  if (op == BOUNDARY_CAPTURE_END) {
    hvir_terminal_selection_context context;
    if (!hvir_query_binding_context(env, args[2], &context)) return NULL;
    hvir_terminal_boundary boundary = {0};
    hvir_terminal_result code = hvir_terminal_boundary_capture_end(host, id, &context, &boundary);
    napi_value value = query_result(env, code, boundary.stale);
    if (!value || (boundary.boundary && !put_boundary(env, value, &boundary))) {
      if (boundary.boundary) hvir_terminal_boundary_close(host, id, boundary.boundary);
      return NULL;
    }
    return value;
  }
  if (!u64(env, args[2], &token)) return NULL;
  if (op == QUERY_STEP) return step_query(env, host, id, token);
  if (op == QUERY_PAGE) return page_query(env, host, id, token, args[3], args[4], args[5]);
  if (op == QUERY_RESOLVE_BEGIN || op == BOUNDARY_RESOLVE_BEGIN) {
    hvir_terminal_selection_context context;
    bool reveal;
    uint64_t occurrence = 0;
    size_t flag = op == QUERY_RESOLVE_BEGIN ? 4 : 3;
    if ((op == QUERY_RESOLVE_BEGIN && !u64(env, args[3], &occurrence)) ||
        !bool_argument(env, args[flag], &reveal) ||
        !hvir_query_binding_context(env, args[flag + 1], &context)) return NULL;
    hvir_terminal_selection_result observed = {0};
    hvir_terminal_result code = op == QUERY_RESOLVE_BEGIN
      ? hvir_terminal_query_resolve_begin(host, id, token, occurrence, reveal, &context, &observed)
      : hvir_terminal_boundary_resolve_begin(host, id, token, reveal, &context, &observed);
    return cursor_value(env, host, id, code, &observed);
  }
  hvir_terminal_result code = op == QUERY_CLEAR_REVEAL
    ? hvir_terminal_query_clear_reveal(host, id, token)
    : op == QUERY_CLOSE ? hvir_terminal_query_close(host, id, token)
    : hvir_terminal_boundary_close(host, id, token);
  return query_result(env, code, false);
}
bool hvir_query_binding_register(napi_env env, napi_value exports) {
  static const char *names[] = {"queryBegin", "queryStep", "queryPage", "queryResolveBegin",
    "queryClearReveal", "queryClose", "rangeBegin", "semanticBoundaryCaptureEnd",
    "semanticBoundaryResolveBegin", "semanticBoundaryClose", "queryContext"};
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    napi_value function;
    if (!checked(env, napi_create_function(env, names[i], NAPI_AUTO_LENGTH, invoke_query,
        (void *)(uintptr_t)i, &function)) || !put(env, exports, names[i], function)) return false;
  }
  return true;
}
