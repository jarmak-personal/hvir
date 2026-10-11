#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <string.h>

/* Private LocalHost mechanics; no validation, grants, revision or stale-owner policy. */
static napi_value failure(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static int get_fd(napi_env env, napi_value value, int *fd) {
  return napi_get_value_int32(env, value, fd) == napi_ok && *fd >= 0;
}

static napi_value lock_writer(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], result;
  int fd;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1 || !get_fd(env, args[0], &fd)) return failure(env, "Invalid extension writer descriptor");
  int status = flock(fd, LOCK_EX | LOCK_NB);
  if (status != 0 && errno != EWOULDBLOCK && errno != EAGAIN) return failure(env, "Extension writer lock failed");
  napi_get_boolean(env, status == 0, &result);
  return result;
}

static napi_value open_child(napi_env env, napi_callback_info info) {
  size_t count = 3, length;
  napi_value args[3], result;
  char name[256];
  int parent;
  bool directory;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 3 || !get_fd(env, args[0], &parent) ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length == 0 || length >= sizeof(name) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok) return failure(env, "Invalid package entry");
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &length);
  if (strlen(name) != length || strchr(name, '/') || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return failure(env, "Invalid package entry name");
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (directory ? O_DIRECTORY : 0));
  if (fd < 0) return failure(env, "Package entry changed or is not a contained regular entry");
  napi_create_int32(env, fd, &result);
  return result;
}

/* Exclusive creation stays relative to an already opened, no-follow parent. */
static napi_value create_child(napi_env env, napi_callback_info info) {
  size_t count = 3, length;
  napi_value args[3], result;
  char name[256];
  int parent;
  bool directory;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 3 || !get_fd(env, args[0], &parent) ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length == 0 || length >= sizeof(name) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok) return failure(env, "Invalid authoring entry");
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &length);
  if (strlen(name) != length || strchr(name, '/') || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return failure(env, "Invalid authoring entry name");
  if (directory && mkdirat(parent, name, 0700) != 0) return failure(env, "Authoring staging directory could not be created");
  int fd = openat(parent, name, O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK |
    (directory ? O_RDONLY | O_DIRECTORY : O_WRONLY | O_CREAT | O_EXCL), 0600);
  if (fd < 0) return failure(env, "Authoring entry could not be created without replacing content");
  struct stat opened, named;
  if (fstat(fd, &opened) != 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      opened.st_dev != named.st_dev || opened.st_ino != named.st_ino ||
      (directory ? !S_ISDIR(opened.st_mode) : !S_ISREG(opened.st_mode))) {
    close(fd);
    return failure(env, "Authoring entry changed during creation; preserved for inspection");
  }
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value unlink_child(napi_env env, napi_callback_info info) {
  size_t count = 5, length;
  napi_value args[5], result;
  char name[256];
  int parent;
  bool directory;
  double dev, ino;
  struct stat current;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 5 || !get_fd(env, args[0], &parent) ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length == 0 || length >= sizeof(name) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok ||
      napi_get_value_double(env, args[3], &dev) != napi_ok || napi_get_value_double(env, args[4], &ino) != napi_ok) return failure(env, "Invalid cleanup entry");
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &length);
  if (strlen(name) != length || strchr(name, '/') || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return failure(env, "Invalid cleanup entry name");
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) != 0 || current.st_dev != (dev_t) dev || current.st_ino != (ino_t) ino ||
      (directory ? !S_ISDIR(current.st_mode) : (!S_ISREG(current.st_mode) && !S_ISLNK(current.st_mode)))) return failure(env, "Stored package entry changed before cleanup");
  if (unlinkat(parent, name, directory ? AT_REMOVEDIR : 0) != 0) return failure(env, "Stored package cleanup failed");
  napi_get_undefined(env, &result);
  return result;
}

static napi_value entry_names(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  int fd, limit;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || !get_fd(env, args[0], &fd) || napi_get_value_int32(env, args[1], &limit) != napi_ok || limit < 1 || limit > 4096) return failure(env, "Invalid package enumeration bound");
  int duplicate = dup(fd);
  if (duplicate < 0) return failure(env, "Cannot enumerate package directory");
  DIR *directory = fdopendir(duplicate);
  if (!directory) { close(duplicate); return failure(env, "Cannot enumerate package directory"); }
  rewinddir(directory);
  napi_create_array(env, &result);
  uint32_t index = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (index >= (uint32_t) limit) { closedir(directory); return failure(env, "Package directory has too many entries"); }
    napi_value name;
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, result, index++, name);
    errno = 0;
  }
  int enumeration_error = errno;
  closedir(directory);
  if (enumeration_error) return failure(env, "Package directory enumeration failed");
  return result;
}

static napi_value metadata(napi_env env, napi_callback_info info) {
  (void) info;
  napi_value result;
  napi_create_string_utf8(env, "hvir.extension-storage.v1", NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"lockWriter", NULL, lock_writer, NULL, NULL, NULL, napi_default, NULL},
    {"openChild", NULL, open_child, NULL, NULL, NULL, napi_default, NULL},
    {"createChild", NULL, create_child, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkChild", NULL, unlink_child, NULL, NULL, NULL, napi_default, NULL},
    {"entryNames", NULL, entry_names, NULL, NULL, NULL, napi_default, NULL},
    {"metadata", NULL, metadata, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
