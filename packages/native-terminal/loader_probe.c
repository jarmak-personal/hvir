#include "hvir_ghostty_embed.h"
#include "ghostty.h"
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

/* Separate-process dependency proof: never initializes a terminal or PTY. */
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) {
    const char *error = dlerror();
    fprintf(stderr, "native-loader: open failed: %s\n", error ? error : "unknown dynamic loader error");
    return 70;
  }
  int result = 0;
  hvir_ghostty_embed_abi_fn abi = (hvir_ghostty_embed_abi_fn)dlsym(library, "hvir_ghostty_embed_abi");
  ghostty_info_s (*info)(void) = (ghostty_info_s (*)(void))dlsym(library, "ghostty_info");
  if (!abi || !info || abi() != HVIR_GHOSTTY_EMBED_ABI) {
    fputs("native-loader: embedding ABI mismatch\n", stderr); result = 71;
  } else {
    ghostty_info_s value = info();
    if (!value.version || value.version_len != strlen(argv[2]) ||
        memcmp(value.version, argv[2], value.version_len) || value.build_mode != GHOSTTY_BUILD_MODE_RELEASE_FAST) {
      fputs("native-loader: build identity mismatch\n", stderr); result = 72;
    } else { puts("HVIR_NATIVE_LOADER_OK"); }
  }
  if (dlclose(library) != 0 && result == 0) result = 73;
  return result;
}
