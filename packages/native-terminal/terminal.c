#define _POSIX_C_SOURCE 200809L
#include "terminal.h"
#include "hvir_ghostty_embed.h"
#include "ghostty.h"
#include "linux_display.h"
#include "terminal_internal.h"
#include <dlfcn.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <math.h>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#endif

static pthread_mutex_t loader_lock = PTHREAD_MUTEX_INITIALIZER;
static void *initialized_library;
static char *initialized_path;
static bool initialization_ok;

static void info_string(char *out, const uint8_t *value, size_t length) {
  if (!value) length = 0;
  if (length >= HVIR_TERMINAL_INFO_MAX) length = HVIR_TERMINAL_INFO_MAX - 1;
  if (length) memcpy(out, value, length);
  out[length] = 0;
}
static void renderer_info(void *userdata, const hvir_ghostty_renderer_info *info) {
  terminal_state *s = userdata;
  if (!info) return;
  pthread_mutex_lock(&s->host->events);
  if (!s->closing) {
    hvir_terminal_renderer_info *out = &s->renderer_info;
    info_string(out->gl_vendor, info->gl_vendor, info->gl_vendor_len);
    info_string(out->gl_renderer, info->gl_renderer, info->gl_renderer_len);
    info_string(out->gl_version, info->gl_version, info->gl_version_len);
    info_string(out->egl_vendor, info->egl_vendor, info->egl_vendor_len);
    info_string(out->egl_version, info->egl_version, info->egl_version_len);
    hvir_linux_display_render_node(s->host->owned_display, info->egl_display, out->render_node);
    out->available = true;
  }
  pthread_mutex_unlock(&s->host->events);
}

hvir_terminal_result hvir_internal_owner(hvir_terminal_host *host) {
  if (!host || host->closing)
    return HVIR_CLOSED;
  return pthread_equal(host->caller, pthread_self()) ? HVIR_OK : HVIR_WRONG_THREAD;
}
terminal_state *hvir_internal_lookup(hvir_terminal_host *host, uint64_t id) {
  for (terminal_state *s = host->states; s; s = s->next)
    if (s->id == id)
      return s;
  return NULL;
}
hvir_terminal_result hvir_internal_state(hvir_terminal_host *host, uint64_t id, terminal_state **out,
                                      bool allow_failure) {
  hvir_terminal_result result = hvir_internal_owner(host);
  if (result != HVIR_OK)
    return result;
  terminal_state *s = hvir_internal_lookup(host, id);
  if (!s || (s->closing && !allow_failure))
    return HVIR_CLOSED;
  pthread_mutex_lock(&host->events);
  bool failed = s->failure != 0;
  pthread_mutex_unlock(&host->events);
  if (failed && !allow_failure)
    return HVIR_FAILED;
  *out = s;
  return HVIR_OK;
}
static void wakeup(void *userdata) {
  hvir_terminal_host *h = userdata;
  pthread_mutex_lock(&h->events);
  pthread_cond_broadcast(&h->changed);
  pthread_mutex_unlock(&h->events);
}
static bool action(ghostty_app_t app, ghostty_target_s target, ghostty_action_s event) {
  (void)app;
  (void)target;
  (void)event;
  /* Effects acquire product authority only in the later effect adapter. */
  return false;
}
static ghostty_clipboard_read_result_e read_clipboard(void *u, ghostty_clipboard_e c, void *s,
                                                      const char *const *m, size_t n, bool z) {
  (void)u;
  (void)c;
  (void)s;
  (void)m;
  (void)n;
  (void)z;
  return GHOSTTY_CLIPBOARD_READ_UNAVAILABLE;
}
static void confirm_clipboard(void *u, const ghostty_clipboard_confirm_s *c, void *s,
                              ghostty_clipboard_request_e r) {
  (void)u;
  (void)c;
  (void)s;
  (void)r;
}
static void write_clipboard(void *u, ghostty_clipboard_e c, const ghostty_clipboard_content_s *d,
                            size_t n, bool z) {
  (void)u;
  (void)c;
  (void)d;
  (void)n;
  (void)z;
}
static bool reply(void *userdata, const uint8_t *bytes, size_t length) {
  terminal_state *s = userdata;
  hvir_terminal_host *h = s->host;
  pthread_mutex_lock(&h->events);
  bool accepted = !s->closing && !s->failure && length <= HVIR_TERMINAL_REPLY_MAX - s->reply_count;
  if (accepted) {
    for (size_t i = 0; i < length; i++)
      s->replies[(s->reply_start + s->reply_count + i) % HVIR_TERMINAL_REPLY_MAX] = bytes[i];
    s->reply_count += length;
    s->reply_sequence++;
  } else if (!s->closing && !s->failure)
    s->failure = 1;
  pthread_cond_broadcast(&h->changed);
  pthread_mutex_unlock(&h->events);
  return accepted;
}
static void renderer_health(void *userdata, uint32_t health) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  if (!s->closing)
    s->renderer_health = health;
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
}
static void clear_frame(terminal_state *s) {
#ifdef __APPLE__
  if (s->frame.kind == 1 && s->frame.surface)
    CFRelease(s->frame.surface);
#endif
  if (s->frame.kind == 2)
    for (uint32_t i = 0; i < s->frame.plane_count && i < 4; i++)
      if (s->frame.fds[i] >= 0)
        close(s->frame.fds[i]);
  if (s->frame.kind == 3)
    free((void *)s->frame.pixels);
  memset(&s->frame, 0, sizeof(s->frame));
  s->frame_available = false;
  s->frame_taken = false;
}
static bool frame_ready(void *userdata, const hvir_ghostty_external_frame *native) {
  terminal_state *s = userdata;
  hvir_terminal_host *h = s->host;
  pthread_mutex_lock(&h->events);
  if (s->closing || s->failure) {
    pthread_mutex_unlock(&h->events);
    return false;
  }
  if (native->kind == 3 && s->renderer_info.pixel_frames != UINT64_MAX)
    s->renderer_info.pixel_frames++;
  if (native->kind == 2 && s->renderer_info.dma_buf_frames != UINT64_MAX)
    s->renderer_info.dma_buf_frames++;
  if (s->frame_available) {
    /* A duplicate producer completion must not unfreeze an existing lease. */
    s->presentation_failure = 5;
    pthread_mutex_unlock(&h->events);
    return true;
  }
  if (!native->width || !native->height || native->width > 8192 || native->height > 8192 ||
      h->next_lease == UINT64_MAX) {
    s->presentation_failure = 5;
    pthread_cond_broadcast(&h->changed);
    pthread_mutex_unlock(&h->events);
    return false;
  }
  hvir_terminal_frame frame = {.kind = native->kind,
                               .width = native->width,
                               .height = native->height,
                               .fourcc = native->fourcc,
                               .plane_count = native->plane_count,
                               .premultiplied = native->premultiplied,
                               .color_space = native->color_space,
                               .origin = native->origin,
                               .modifier = native->modifier,
                               .stream_sequence = native->stream,
                               .geometry_serial = native->geometry,
                               .snapshot_mutation = native->mutation, .screen = native->screen};
  bool valid = native->screen <= 1;
  if (native->kind == 1) {
#ifdef __APPLE__
    frame.surface = native->surface;
    if (frame.surface)
      CFRetain(frame.surface);
    else
      valid = false;
#else
    valid = false;
#endif
  } else if (native->kind == 2) {
    if (!native->plane_count || native->plane_count > 4)
      valid = false;
    for (uint32_t i = 0; i < 4; i++)
      frame.fds[i] = -1;
    for (uint32_t i = 0; valid && i < native->plane_count; i++) {
      frame.fds[i] = fcntl(native->fds[i], F_DUPFD_CLOEXEC, 0);
      frame.strides[i] = native->strides[i];
      frame.offsets[i] = native->offsets[i];
      off_t size = frame.fds[i] < 0 ? -1 : lseek(frame.fds[i], 0, SEEK_END);
      if (size <= 0 || !frame.strides[i] ||
          (uint64_t)frame.offsets[i] + frame.strides[i] > (uint64_t)size)
        valid = false;
      else {
        frame.sizes[i] = (uint64_t)size;
        (void)lseek(frame.fds[i], 0, SEEK_SET);
      }
    }
  } else if (native->kind == 3) {
    uint64_t required = (uint64_t)native->width * native->height * 4;
    if (!native->pixels || !required || required > HVIR_TERMINAL_PIXEL_MAX ||
        native->pixel_bytes != required)
      valid = false;
    else {
      uint8_t *copy = malloc(native->pixel_bytes);
      if (!copy)
        valid = false;
      else {
        memcpy(copy, native->pixels, native->pixel_bytes);
        frame.pixels = copy;
        frame.pixel_bytes = native->pixel_bytes;
      }
    }
  } else
    valid = false;
  s->frame = frame;
  if (!valid) {
    clear_frame(s);
    s->presentation_failure = 5;
  } else {
    s->presentation_failure = 0;
    s->frame.lease = ++h->next_lease;
    s->frame_available = true;
  }
  pthread_cond_broadcast(&h->changed);
  pthread_mutex_unlock(&h->events);
  return valid;
}
static void applied(void *userdata, uint64_t serial, uint32_t cols, uint32_t rows, uint32_t width,
                    uint32_t height, uint32_t cell_width, uint32_t cell_height,
                    uint32_t content_width, uint32_t content_height, uint32_t padding_left,
                    uint32_t padding_top, double backing_scale) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  if (!s->closing && !s->failure && serial == s->requested_geometry && serial != s->geometry_failure_serial) {
    s->geometry = (hvir_terminal_geometry){.serial = serial, .backing_scale = backing_scale,
      .columns = cols, .rows = rows, .width = width, .height = height,
      .cell_width = cell_width, .cell_height = cell_height, .content_width = content_width,
      .content_height = content_height, .padding_left = padding_left, .padding_top = padding_top};
    s->geometry_failure_serial = 0;
  }
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
}
static void failed(void *userdata, uint32_t reason) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  if (!s->closing && !s->failure)
    s->failure = reason ? reason : 1;
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
}
#define LOAD(field, symbol)                                                                        \
  do {                                                                                             \
    *(void **)(&h->field) = dlsym(library, symbol);                                                \
    if (!h->field)                                                                                 \
      goto bad_library;                                                                            \
  } while (0)
hvir_terminal_result hvir_terminal_open(const char *path, void *display, hvir_terminal_host **out) {
  if (!path || !out)
    return HVIR_INVALID;
  *out = NULL;
  hvir_terminal_host *h = calloc(1, sizeof(*h));
  if (!h)
    return HVIR_NOMEM;
  h->caller = pthread_self();
  h->display = display;
  h->next_id = 1;
  if (pthread_mutex_init(&h->events, NULL)) {
    free(h);
    return HVIR_FAILED;
  }
  if (pthread_cond_init(&h->changed, NULL)) {
    pthread_mutex_destroy(&h->events);
    free(h);
    return HVIR_FAILED;
  }
  pthread_mutex_lock(&loader_lock);
  void *library = initialized_library;
  bool opened = false;
  if (library && (!initialized_path || !initialization_ok || strcmp(initialized_path, path)))
    goto bad_library;
  if (!library) {
    library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    opened = library != NULL;
  }
  if (!library)
    goto bad_library;
  hvir_ghostty_embed_abi_fn abi =
      (hvir_ghostty_embed_abi_fn)dlsym(library, "hvir_ghostty_embed_abi");
  if (!abi || abi() != HVIR_GHOSTTY_EMBED_ABI)
    goto bad_library;
  LOAD(init, "ghostty_init");
  LOAD(config_new, "ghostty_config_new");
  LOAD(config_free, "ghostty_config_free");
  LOAD(config_finalize, "ghostty_config_finalize");
  LOAD(app_new, "ghostty_app_new");
  LOAD(app_free, "ghostty_app_free");
  LOAD(app_tick, "ghostty_app_tick");
  LOAD(surface_free, "ghostty_surface_free");
  LOAD(external_new, "ghostty_external_surface_new");
  LOAD(external_frame_release, "ghostty_external_frame_release");
  LOAD(external_presentation_mode, "ghostty_external_set_presentation_mode");
  LOAD(external_feed, "ghostty_external_feed");
  LOAD(external_resize, "ghostty_external_resize");
  LOAD(surface_visibility, "ghostty_surface_set_occlusion");
  LOAD(external_link, "ghostty_external_link");
  LOAD(external_selection, "ghostty_external_selection");
  LOAD(external_extract_begin, "ghostty_external_extract_begin");
  LOAD(external_link_row_begin, "ghostty_external_link_row_begin");
  LOAD(external_extract_next, "ghostty_external_extract_next");
  LOAD(external_extract_finish, "ghostty_external_extract_finish");
  LOAD(external_extract_close, "ghostty_external_extract_close");
  LOAD(external_link_current, "ghostty_external_link_current");
  LOAD(external_read, "ghostty_external_read");
  LOAD(external_key, "ghostty_external_key");
  LOAD(external_input, "ghostty_external_input");
  LOAD(external_input_capacity, "ghostty_external_input_capacity");
  if (!initialized_library) {
    /* ghostty_init installs process-global state without a global shutdown API.
     * Keep even a failed initialization mapped; never call dangling destructors. */
    initialized_path = strdup(path);
    if (!initialized_path)
      goto bad_library;
    initialized_library = library;
    opened = false;
    initialization_ok = h->init(0, NULL) == 0;
    if (!initialization_ok)
      goto bad_library;
  }
  pthread_mutex_unlock(&loader_lock);
  ghostty_config_t config = h->config_new();
  if (!config)
    goto failed_app;
  h->config_finalize(config); /* Never load CLI, user files, recursive input or default config. */
  ghostty_runtime_config_s runtime = {.userdata = h,
                                      .wakeup_cb = wakeup,
                                      .action_cb = action,
                                      .read_clipboard_cb = read_clipboard,
                                      .confirm_read_clipboard_cb = confirm_clipboard,
                                      .write_clipboard_cb = write_clipboard};
  h->app = h->app_new(&runtime, config);
  h->config_free(config);
  if (!h->app)
    goto failed_app;
  *out = h;
  return HVIR_OK;
bad_library:
  if (opened)
    dlclose(library); /* Info/symbol validation only; initialization never ran. */
  pthread_mutex_unlock(&loader_lock);
failed_app:
  pthread_cond_destroy(&h->changed);
  pthread_mutex_destroy(&h->events);
  free(h);
  return HVIR_FAILED;
}
hvir_terminal_result hvir_terminal_open_linux(const char *path, const char *node,
                                              uint32_t mode, hvir_terminal_host **out) {
  if (!out || mode > 1) return HVIR_INVALID;
  *out = NULL;
#ifndef __linux__
  (void)path; (void)node;
  return HVIR_PRESENTATION;
#else
  hvir_linux_display *owned = NULL;
  void *display = NULL;
  hvir_terminal_result result = hvir_linux_display_open(node, &owned, &display);
  if (result != HVIR_OK) return result;
  result = hvir_terminal_open(path, display, out);
  if (result != HVIR_OK) { hvir_linux_display_close(owned); return result; }
  (*out)->owned_display = owned;
  (*out)->initial_presentation_mode = mode;
  return HVIR_OK;
#endif
}
#undef LOAD
static bool dimensions(uint32_t width, uint32_t height) {
  return width >= 32 && height >= 32 && width <= 8192 && height <= 8192;
}
static void feed_applied(void *userdata, uint64_t sequence) {
  terminal_state *s = userdata;
  pthread_mutex_lock(&s->host->events);
  /* Callback may precede the designated caller returning from external_feed. */
  if (!s->closing && sequence > s->io_applied_sequence)
    s->io_applied_sequence = sequence;
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
}
hvir_terminal_result hvir_terminal_create_begin(hvir_terminal_host *h, uint32_t width,
                                                uint32_t height, hvir_terminal_id *out) {
  hvir_terminal_result r = hvir_internal_owner(h);
  if (r)
    return r;
  if (!out || !dimensions(width, height) || h->next_id == UINT64_MAX)
    return HVIR_INVALID;
  *out = 0;
  terminal_state *s = calloc(1, sizeof(*s));
  if (!s)
    return HVIR_NOMEM;
  s->id = h->next_id++;
  s->host = h;
  s->requested_geometry = 1;
  hvir_ghostty_external_config callbacks = {.userdata = s,
                                            .write = reply,
                                            .applied = applied,
                                            .failed = failed,
                                            .scrollback_limit = 10000000,
                                            .effect = hvir_internal_effect,
                                            .health = renderer_health,
                                            .frame = frame_ready,
                                            .pixel_export_limit = HVIR_TERMINAL_PIXEL_MAX,
                                            .presentation_mode = h->initial_presentation_mode,
                                            .renderer_info = renderer_info,
                                            .input = hvir_internal_input,
                                            .mutation_applied = hvir_internal_mutation_applied,
                                            .feed_applied = feed_applied};
  s->surface = h->external_new(h->app, h->states ? NULL : h->display, &callbacks, width, height);
  if (!s->surface) {
    /* Native partial initialization has settled its threads before returning.
     * A completed-resource callback may already have acquired C references. */
    clear_frame(s);
    hvir_internal_clear_effects(s);
    free(s);
    return HVIR_FAILED;
  }
  s->next = h->states;
  h->states = s;
  if (!h->external_resize(s->surface, width, height, 1, 1)) {
    (void)hvir_terminal_destroy(h, s->id);
    return HVIR_PRESENTATION;
  }
  *out = s->id;
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_create(hvir_terminal_host *h, uint32_t width, uint32_t height,
                                          hvir_terminal_id *out) {
  hvir_terminal_result result = hvir_terminal_create_begin(h, width, height, out);
  if (result != HVIR_OK)
    return result;
  terminal_state *s = hvir_internal_lookup(h, *out);
  *out = 0;
  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += 10;
  for (;;) {
    h->app_tick(h->app);
    pthread_mutex_lock(&h->events);
    bool ready = s->geometry.serial == 1, failure = s->failure != 0;
    int waited = 0;
    if (!ready && !failure)
      waited = pthread_cond_timedwait(&h->changed, &h->events, &deadline);
    pthread_mutex_unlock(&h->events);
    if (ready) {
      *out = s->id;
      return HVIR_OK;
    }
    if (failure || waited) {
      hvir_terminal_destroy(h, s->id);
      return failure ? HVIR_FAILED : HVIR_TIMEOUT;
    }
  }
}
hvir_terminal_result hvir_terminal_feed(hvir_terminal_host *h, hvir_terminal_id id,
                                        uint64_t sequence, const uint8_t *bytes, size_t length) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, false);
  if (r)
    return r;
  if ((!bytes && length) || length > HVIR_TERMINAL_FEED_MAX)
    return HVIR_BOUND;
  if (!sequence || s->applied_sequence == UINT64_MAX || sequence != s->applied_sequence + 1)
    return HVIR_INVALID;
  if (!h->external_feed(s->surface, bytes ? bytes : (const uint8_t *)"", length, sequence))
    return HVIR_FAILED;
  s->applied_sequence = sequence;
  h->app_tick(h->app);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_drain(hvir_terminal_host *h, hvir_terminal_id id, uint8_t *out,
                                         size_t capacity, size_t *written) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, true);
  if (r)
    return r;
  if (!out || !written || capacity > HVIR_TERMINAL_REPLY_MAX)
    return HVIR_BOUND;
  h->app_tick(h->app);
  pthread_mutex_lock(&h->events);
  size_t count = s->reply_count < capacity ? s->reply_count : capacity;
  for (size_t i = 0; i < count; i++)
    out[i] = s->replies[(s->reply_start + i) % HVIR_TERMINAL_REPLY_MAX];
  s->reply_start = (s->reply_start + count) % HVIR_TERMINAL_REPLY_MAX;
  s->reply_count -= count;
  pthread_mutex_unlock(&h->events);
  *written = count;
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_read(hvir_terminal_host *h, hvir_terminal_id id, uint8_t *out,
                                        size_t capacity, size_t *written) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, false);
  if (r)
    return r;
  if (!out || !written || !capacity || capacity > HVIR_TERMINAL_TEXT_MAX)
    return HVIR_BOUND;
  *written = 0;
  return h->external_read(s->surface, out, capacity, written) ? HVIR_OK : HVIR_BOUND;
}
hvir_terminal_result hvir_terminal_resize(hvir_terminal_host *h, hvir_terminal_id id,
                                          uint64_t serial, uint32_t width, uint32_t height) {
  return hvir_terminal_resize_scaled(h, id, serial, width, height, 1);
}
hvir_terminal_result hvir_terminal_resize_scaled(hvir_terminal_host *h, hvir_terminal_id id,
                                                 uint64_t serial, uint32_t width, uint32_t height,
                                                 double backing_scale) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, false);
  if (r) return r;
  if (!dimensions(width, height) || !isfinite(backing_scale) || backing_scale < 1 || backing_scale > 4)
    return HVIR_BOUND;
  pthread_mutex_lock(&h->events);
  if (!serial || serial <= s->requested_geometry) {
    pthread_mutex_unlock(&h->events);
    return HVIR_INVALID;
  }
  s->requested_geometry = serial;
  pthread_mutex_unlock(&h->events);
  if (!h->external_resize(s->surface, width, height, serial, backing_scale)) {
    pthread_mutex_lock(&h->events);
    s->geometry_failure_serial = serial;
    s->presentation_failure = HVIR_PRESENTATION;
    pthread_mutex_unlock(&h->events);
    return HVIR_PRESENTATION;
  }
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_visibility(hvir_terminal_host *h, hvir_terminal_id id,
                                              uint32_t visible) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, false);
  if (result != HVIR_OK) return result;
  if (visible > 1) return HVIR_INVALID;
  h->surface_visibility(s->surface, visible != 0);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_inspect(hvir_terminal_host *h, hvir_terminal_id id,
                                           hvir_terminal_status *out) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, true);
  if (r)
    return r;
  if (!out)
    return HVIR_INVALID;
  h->app_tick(h->app);
  pthread_mutex_lock(&h->events);
  *out = (hvir_terminal_status){.applied_sequence = s->applied_sequence,
    .io_applied_mutation = s->io_applied_mutation, .input_failure = s->input_failure,
    .io_applied_sequence = s->io_applied_sequence,
                                .frame_copies = s->frame_copies,
                                .geometry_failure_serial = s->geometry_failure_serial,
                                .reply_sequence = s->reply_sequence,
                                .queued_reply_bytes = s->reply_count,
                                .failure = s->failure,
                                .closing = s->closing,
                                .renderer_health = s->renderer_health,
                                .presentation_failure = s->presentation_failure,
                                .geometry = s->geometry};
  pthread_mutex_unlock(&h->events);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_key(hvir_terminal_host *h, hvir_terminal_id id, uint32_t key,
                                       uint32_t mods, uint32_t action_value, const char *text,
                                       uint8_t *out, size_t capacity, size_t *written) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, false);
  if (r)
    return r;
  if (!text || !out || !written || capacity > HVIR_TERMINAL_FEED_MAX)
    return HVIR_BOUND;
  size_t length = strnlen(text, HVIR_TERMINAL_FEED_MAX + 1);
  if (length > HVIR_TERMINAL_FEED_MAX)
    return HVIR_BOUND;
  *written = 0;
  return h->external_key(s->surface, (int)key, mods, (int)action_value, (const uint8_t *)text,
                         length, out, capacity, written)
             ? HVIR_OK
             : HVIR_INVALID;
}
hvir_terminal_result hvir_terminal_take_frame(hvir_terminal_host *h, hvir_terminal_id id,
                                              hvir_terminal_frame *out) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, false);
  if (r)
    return r;
  if (!out)
    return HVIR_INVALID;
  h->app_tick(h->app);
  pthread_mutex_lock(&h->events);
  if (!s->frame_available || s->frame_taken) {
    hvir_terminal_result availability =
        s->presentation_failure || s->renderer_health == GHOSTTY_RENDERER_HEALTH_UNHEALTHY
            ? HVIR_PRESENTATION : HVIR_BUSY;
    pthread_mutex_unlock(&h->events);
    return availability;
  }
  if (s->geometry.serial != s->requested_geometry || s->geometry_failure_serial ||
      s->frame.geometry_serial != s->geometry.serial || s->frame.width != s->geometry.width ||
      s->frame.height != s->geometry.height) {
    clear_frame(s);
    pthread_mutex_unlock(&h->events);
    return h->external_frame_release(s->surface) ? HVIR_BUSY : HVIR_PRESENTATION;
  }
  s->frame_taken = true;
  *out = s->frame;
  pthread_mutex_unlock(&h->events);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_copy_frame(hvir_terminal_host *h, hvir_terminal_id id,
                                              uint64_t lease, uint8_t *out, size_t capacity,
                                              size_t *written, uint32_t *stride) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, true);
  if (result != HVIR_OK) return result;
  if (!out || !written || !stride) return HVIR_INVALID;
  *written = 0; *stride = 0;
  if (!capacity || capacity > HVIR_TERMINAL_PIXEL_MAX) return HVIR_BOUND;
  if (!lease || !s->frame_taken || s->frame.lease != lease) return HVIR_INVALID;
  const hvir_terminal_frame *frame = &s->frame;
  if (frame->kind == 3) {
    const size_t width = frame->width, height = frame->height;
    if (!width || !height || width > HVIR_TERMINAL_PIXEL_MAX / 4 ||
        height > HVIR_TERMINAL_PIXEL_MAX / (width * 4)) return HVIR_BOUND;
    const size_t row = width * 4, bytes = row * height;
    if (!frame->pixels || frame->pixel_bytes != bytes) return HVIR_PRESENTATION;
    if (capacity < bytes || s->frame_copies == UINT64_MAX) return HVIR_BOUND;
    for (size_t at = 0; at < bytes; at += 4) {
      out[at] = frame->pixels[at + 2]; out[at + 1] = frame->pixels[at + 1];
      out[at + 2] = frame->pixels[at]; out[at + 3] = frame->pixels[at + 3];
    }
    *written = bytes; *stride = (uint32_t)row;
    s->frame_copies++;
    return HVIR_OK;
  }
#ifdef __APPLE__
  if (frame->kind != 1 || !frame->surface) return HVIR_PRESENTATION;
  IOSurfaceRef surface = frame->surface;
  const size_t width = frame->width, height = frame->height;
  if (!width || !height || width > HVIR_TERMINAL_PIXEL_MAX / 4 ||
      height > HVIR_TERMINAL_PIXEL_MAX / (width * 4)) return HVIR_BOUND;
  const size_t packed_stride = width * 4, bytes = packed_stride * height;
  if (s->frame_copies == UINT64_MAX) return HVIR_BOUND;
  if (capacity < bytes) return HVIR_BOUND;
  if (IOSurfaceGetPlaneCount(surface) || IOSurfaceGetWidth(surface) != width ||
      IOSurfaceGetHeight(surface) != height || IOSurfaceGetPixelFormat(surface) != 0x42475241u)
    return HVIR_PRESENTATION;
  const size_t source_stride = IOSurfaceGetBytesPerRow(surface);
  const size_t allocation = IOSurfaceGetAllocSize(surface);
  if (source_stride < packed_stride || source_stride > SIZE_MAX / height ||
      source_stride * height > allocation) return HVIR_PRESENTATION;
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess)
    return HVIR_PRESENTATION;
  const uint8_t *source = IOSurfaceGetBaseAddress(surface);
  if (source)
    for (size_t row = 0; row < height; row++)
      memcpy(out + row * packed_stride, source + row * source_stride, packed_stride);
  const bool unlocked = IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL) == kIOReturnSuccess;
  if (!source || !unlocked) return HVIR_PRESENTATION;
  *written = bytes; *stride = (uint32_t)packed_stride;
  s->frame_copies++;
  return HVIR_OK;
#else
  return HVIR_PRESENTATION;
#endif
}
hvir_terminal_result hvir_terminal_presentation_mode(hvir_terminal_host *h, hvir_terminal_id id,
                                                     uint32_t mode) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, false);
  if (result != HVIR_OK) return result;
  if (mode > 1) return HVIR_INVALID;
#ifndef __linux__
  return HVIR_PRESENTATION;
#else
  return h->external_presentation_mode(s->surface, mode) ? HVIR_OK : HVIR_PRESENTATION;
#endif
}
hvir_terminal_result hvir_terminal_renderer_info_get(hvir_terminal_host *h, hvir_terminal_id id,
                                                     hvir_terminal_renderer_info *out) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, true);
  if (result != HVIR_OK) return result;
  if (!out) return HVIR_INVALID;
  pthread_mutex_lock(&h->events);
  *out = s->renderer_info;
  pthread_mutex_unlock(&h->events);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_release_frame(hvir_terminal_host *h, hvir_terminal_id id,
                                                 uint64_t lease) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, true);
  if (r)
    return r;
  pthread_mutex_lock(&h->events);
  if (lease && lease == s->last_released) {
    pthread_mutex_unlock(&h->events);
    return HVIR_OK;
  }
  if (!lease || !s->frame_taken || lease != s->frame.lease) {
    pthread_mutex_unlock(&h->events);
    return HVIR_INVALID;
  }
  s->last_released = lease;
  clear_frame(s);
  pthread_mutex_unlock(&h->events);
  if (s->surface && !h->external_frame_release(s->surface))
    return HVIR_PRESENTATION;
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_destroy(hvir_terminal_host *h, hvir_terminal_id id) {
  terminal_state *s;
  hvir_terminal_result r = hvir_internal_state(h, id, &s, true);
  if (r)
    return r;
  pthread_mutex_lock(&h->events);
  s->closing = true;
  bool held = s->frame_taken;
  if (!held && s->frame_available)
    clear_frame(s);
  pthread_mutex_unlock(&h->events);
  /* Keep producer quiescent while stopping it; retained OS references outlive the
   * engine, not vice versa. A later release never dereferences this freed Surface. */
  if (s->surface) {
    h->surface_free(s->surface);
    s->surface = NULL;
  }
  if (held)
    return HVIR_BUSY;
  terminal_state **link = &h->states;
  while (*link != s)
    link = &(*link)->next;
  *link = s->next;
  hvir_internal_clear_effects(s);
  free(s);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_close(hvir_terminal_host *h) {
  hvir_terminal_result r = hvir_internal_owner(h);
  if (r)
    return r;
  if (h->states)
    return HVIR_BUSY;
  h->closing = true;
  h->app_free(h->app);
  hvir_linux_display_close(h->owned_display);
  pthread_cond_destroy(&h->changed);
  pthread_mutex_destroy(&h->events);
  free(h);
  return HVIR_OK;
}
