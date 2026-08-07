/*
 * Derived from Skill Steward's MIT-licensed rename_noreplace binding.
 * Copyright (c) 2026 Skill Steward contributors.
 * Modified for hvir to accept separate source and destination parent fds.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#endif

#define HVIR_MAX_BASENAME_BYTES 255

static napi_value hvir_metadata(napi_env env, napi_callback_info info) {
  (void) info;
  napi_value result;
  if (napi_create_string_utf8(
        env,
        "hvir.rename-noreplace.v1",
        NAPI_AUTO_LENGTH,
        &result
      ) != napi_ok) {
    return NULL;
  }
  return result;
}

static int hvir_read_basename(napi_env env, napi_value value, char **output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok
      || length == 0
      || length > HVIR_MAX_BASENAME_BYTES) {
    return EINVAL;
  }
  char *buffer = (char *) malloc(length + 1);
  if (buffer == NULL) return ENOMEM;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &written) != napi_ok
      || written != length
      || memchr(buffer, '\0', length) != NULL
      || strchr(buffer, '/') != NULL
      || strcmp(buffer, ".") == 0
      || strcmp(buffer, "..") == 0) {
    free(buffer);
    return EINVAL;
  }
  *output = buffer;
  return 0;
}

static napi_value hvir_rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4) {
    napi_throw_type_error(
      env,
      NULL,
      "renameNoReplace requires source parent fd/name and destination parent fd/name"
    );
    return NULL;
  }

  int32_t source_parent_fd = -1;
  int32_t destination_parent_fd = -1;
  char *source = NULL;
  char *destination = NULL;
  int error =
    napi_get_value_int32(env, argv[0], &source_parent_fd) == napi_ok
      && source_parent_fd >= 0
      ? 0
      : EINVAL;
  if (error == 0) error = hvir_read_basename(env, argv[1], &source);
  if (error == 0) {
    error =
      napi_get_value_int32(env, argv[2], &destination_parent_fd) == napi_ok
        && destination_parent_fd >= 0
        ? 0
        : EINVAL;
  }
  if (error == 0) error = hvir_read_basename(env, argv[3], &destination);

  if (error == 0) {
#if defined(__APPLE__)
    if (renameatx_np(
          source_parent_fd,
          source,
          destination_parent_fd,
          destination,
          RENAME_EXCL
        ) != 0) {
      error = errno;
    }
#elif defined(__linux__) && defined(SYS_renameat2)
    if (syscall(
          SYS_renameat2,
          source_parent_fd,
          source,
          destination_parent_fd,
          destination,
          RENAME_NOREPLACE
        ) != 0) {
      error = errno;
    }
#else
    error = ENOTSUP;
#endif
  }

  free(source);
  free(destination);
  napi_value result;
  if (napi_create_int32(env, error, &result) != napi_ok) return NULL;
  return result;
}

static napi_value hvir_initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "metadata", NULL, hvir_metadata, NULL, NULL, NULL, napi_default, NULL },
    {
      "renameNoReplace",
      NULL,
      hvir_rename_no_replace,
      NULL,
      NULL,
      NULL,
      napi_default,
      NULL
    }
  };
  if (napi_define_properties(
        env,
        exports,
        sizeof(properties) / sizeof(properties[0]),
        properties
      ) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, hvir_initialize)
