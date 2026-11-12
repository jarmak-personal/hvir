#ifndef HVIR_GHOSTTY_EMBED_H
#define HVIR_GHOSTTY_EMBED_H
#include <stdint.h>
/* Version of the pinned upstream hooks, separate from libghostty-vt's ABI. */
#define HVIR_GHOSTTY_EMBED_ABI 1u
typedef uint32_t (*hvir_ghostty_embed_abi_fn)(void);
#endif
