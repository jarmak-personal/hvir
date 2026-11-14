#ifndef HVIR_GHOSTTY_EMBED_H
#define HVIR_GHOSTTY_EMBED_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* Pinned full-core hooks, separate from stable libghostty-vt. Local pointers/FDs
 * belong to this process; M4 must transfer real OS rights across processes. */
#define HVIR_GHOSTTY_EMBED_ABI 7u
typedef uint32_t (*hvir_ghostty_embed_abi_fn)(void);
typedef struct {
  uint32_t kind, width, height, fourcc, plane_count, premultiplied, color_space, origin;
  uint64_t modifier, stream, geometry, mutation;
  void *surface;
  int32_t fds[4];
  uint32_t strides[4], offsets[4];
  const uint8_t *pixels;
  size_t pixel_bytes;
} hvir_ghostty_external_frame;
typedef struct {
  const uint8_t *gl_vendor; size_t gl_vendor_len;
  const uint8_t *gl_renderer; size_t gl_renderer_len;
  const uint8_t *gl_version; size_t gl_version_len;
  const uint8_t *egl_vendor; size_t egl_vendor_len;
  const uint8_t *egl_version; size_t egl_version_len;
  void *egl_display; /* borrowed for this process-local callback only, never IPC */
} hvir_ghostty_renderer_info;
/* Generic terminal-only event, independent of app keymaps and native windows. */
typedef struct {
  uint32_t kind, key, mods, consumed_mods, action, unshifted_codepoint, option_as_alt, encoding_fallback;
  uint32_t composing, focused, precision, has_button, button;
  double x, y, delta_x, delta_y;
  const uint8_t *text;
  size_t text_len;
} hvir_ghostty_input_event;
typedef struct { bool captured; double x, y, width, height; size_t required_capacity; } hvir_ghostty_input_result;
typedef struct {
  uint32_t kind, action, screen, row, column;
  uint64_t sequence, serial;
  const uint8_t *data; size_t data_len;
  const uint8_t *extra; size_t extra_len;
} hvir_ghostty_external_effect;
typedef struct {
  void *userdata;
  bool (*write)(void *, const uint8_t *, size_t);
  void (*applied)(void *, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                  uint32_t, uint32_t, uint32_t, uint32_t, double);
  void (*failed)(void *, uint32_t);
  size_t scrollback_limit;
  bool (*effect)(void *, const hvir_ghostty_external_effect *);
  void (*health)(void *, uint32_t);
  bool (*frame)(void *, const hvir_ghostty_external_frame *);
  size_t pixel_export_limit; /* zero disables external CPU export */
  uint32_t presentation_mode; /* 0 auto, 1 pixels before the first export */
  void (*renderer_info)(void *, const hvir_ghostty_renderer_info *);
  bool (*input)(void *, uint32_t origin, const uint8_t *, size_t);
  void (*mutation_applied)(void *, uint64_t);
  void (*feed_applied)(void *, uint64_t);
} hvir_ghostty_external_config;
#endif
