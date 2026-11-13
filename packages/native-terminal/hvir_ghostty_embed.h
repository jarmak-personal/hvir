#ifndef HVIR_GHOSTTY_EMBED_H
#define HVIR_GHOSTTY_EMBED_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* Pinned full-core hooks, separate from stable libghostty-vt. Local pointers/FDs
 * belong to this process; M4 must transfer real OS rights across processes. */
#define HVIR_GHOSTTY_EMBED_ABI 3u
typedef uint32_t (*hvir_ghostty_embed_abi_fn)(void);
typedef struct {
  uint32_t kind, width, height, fourcc, plane_count, premultiplied, color_space, origin;
  uint64_t modifier, stream, geometry;
  void *surface;
  int32_t fds[4];
  uint32_t strides[4], offsets[4];
  const uint8_t *pixels;
  size_t pixel_bytes;
} hvir_ghostty_external_frame;
typedef struct {
  void *userdata;
  bool (*write)(void *, const uint8_t *, size_t);
  void (*applied)(void *, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                  uint32_t, uint32_t, uint32_t, uint32_t);
  void (*failed)(void *, uint32_t);
  size_t scrollback_limit;
  bool (*effect)(void *, uint32_t, const uint8_t *, size_t);
  void (*health)(void *, uint32_t);
  bool (*frame)(void *, const hvir_ghostty_external_frame *);
} hvir_ghostty_external_config;
#endif
