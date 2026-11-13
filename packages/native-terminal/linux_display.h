#ifndef HVIR_LINUX_DISPLAY_H
#define HVIR_LINUX_DISPLAY_H
#include "terminal.h"
typedef struct hvir_linux_display hvir_linux_display;
/* NULL keeps Ghostty's normal surfaceless selection. An explicit render node
 * owns an initialized display until the app and all native states have closed. */
hvir_terminal_result hvir_linux_display_open(const char *render_node,
                                            hvir_linux_display **owned, void **display);
void hvir_linux_display_render_node(hvir_linux_display *, void *display,
                                     char out[HVIR_TERMINAL_INFO_MAX]);
void hvir_linux_display_close(hvir_linux_display *);
#endif
