#ifndef HVIR_HOST_QUERY_BINDING_H
#define HVIR_HOST_QUERY_BINDING_H
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "terminal.h"

/* Shared private NAPI primitives; public native ABI and resource ownership stay
 * in terminal.h and host_binding.c respectively. */
static inline bool checked(napi_env env, napi_status status) {
  if (status == napi_ok)
    return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending)
    napi_throw_error(env, NULL, "Native terminal binding operation failed");
  return false;
}
static inline void bad_argument(napi_env env) {
  napi_throw_type_error(env, NULL, "Invalid native terminal binding argument");
}
static inline napi_value number(napi_env env, uint32_t value) {
  napi_value result;
  return checked(env, napi_create_uint32(env, value, &result)) ? result : NULL;
}
static inline napi_value real(napi_env env, double value) {
  napi_value result;
  return checked(env, napi_create_double(env, value, &result)) ? result : NULL;
}
static inline napi_value integer(napi_env env, int32_t value) {
  napi_value result;
  return checked(env, napi_create_int32(env, value, &result)) ? result : NULL;
}
static inline napi_value big(napi_env env, uint64_t value) {
  napi_value result;
  return checked(env, napi_create_bigint_uint64(env, value, &result)) ? result : NULL;
}
static inline napi_value boolean(napi_env env, bool value) {
  napi_value result;
  return checked(env, napi_get_boolean(env, value, &result)) ? result : NULL;
}
static inline napi_value object(napi_env env) {
  napi_value result;
  return checked(env, napi_create_object(env, &result)) ? result : NULL;
}
static inline bool put(napi_env env, napi_value target, const char *name, napi_value value) {
  return target && value && checked(env, napi_set_named_property(env, target, name, value));
}
static inline napi_value outcome(napi_env env, hvir_terminal_result code) {
  napi_value result = object(env);
  return put(env, result, "result", number(env, code)) ? result : NULL;
}
static inline napi_value bytes(napi_env env, const void *data, size_t length) {
  napi_value result;
  return checked(env, napi_create_buffer_copy(env, length, data, NULL, &result)) ? result : NULL;
}
static inline bool u32(napi_env env, napi_value value, uint32_t *out) {
  napi_valuetype type;
  double numeric;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &numeric) != napi_ok ||
      !(numeric >= 0 && numeric <= UINT32_MAX) || (double)(uint32_t)numeric != numeric) {
    bad_argument(env);
    return false;
  }
  *out = (uint32_t)numeric;
  return true;
}
static inline bool u64(napi_env env, napi_value value, uint64_t *out) {
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, out, &lossless) != napi_ok || !lossless) {
    bad_argument(env);
    return false;
  }
  return true;
}
static inline char *text(napi_env env, napi_value value, size_t limit) {
  size_t length = 0, written = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > limit) {
    bad_argument(env);
    return NULL;
  }
  char *result = malloc(length + 1);
  if (!result) {
    napi_throw_error(env, NULL, "Native terminal binding allocation failed");
    return NULL;
  }
  if (!checked(env, napi_get_value_string_utf8(env, value, result, length + 1, &written)) ||
      written != length || memchr(result, 0, length)) {
    free(result);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending)
      bad_argument(env);
    return NULL;
  }
  return result;
}

/* The tagged wrapper/resource list never crosses into the query marshaller. */
bool hvir_query_binding_host(napi_env, napi_value, hvir_terminal_host **);
bool hvir_query_binding_context(napi_env, napi_value, hvir_terminal_selection_context *);
napi_value hvir_query_binding_selection(napi_env, hvir_terminal_result,
  const hvir_terminal_selection_result *);
bool hvir_query_binding_resolution(napi_env, napi_value, const hvir_terminal_selection_result *);
bool hvir_query_binding_register(napi_env, napi_value);
#endif
