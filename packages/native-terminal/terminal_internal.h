#ifndef HVIR_TERMINAL_INTERNAL_H
#define HVIR_TERMINAL_INTERNAL_H
#include "terminal.h"
#include "hvir_ghostty_embed.h"
#include "ghostty.h"
#include "linux_display.h"
#include <pthread.h>
/* One application host caller; IO/render callbacks use only events, never caller
 * admission locks. The byte FIFO is bounded independently of native mailboxes. */
typedef struct terminal_state terminal_state;
typedef struct {
  uint32_t kind;
  size_t length;
  uint8_t data[1024];
} queued_effect;
struct terminal_state {
  terminal_state *next;
  struct hvir_terminal_host *host;
  uint64_t io_applied_sequence;
  uint64_t id, applied_sequence, reply_sequence, requested_geometry, frame_copies, geometry_failure_serial;
  ghostty_surface_t surface;
  hvir_terminal_geometry geometry;
  uint8_t replies[HVIR_TERMINAL_REPLY_MAX];
  size_t reply_start, reply_count;
  uint32_t failure, presentation_failure, renderer_health;
  bool closing;
  queued_effect events[128];
  hvir_terminal_event latest[2];
  bool latest_pending[2];
  size_t event_start, event_count;
  hvir_terminal_frame frame;
  bool frame_available, frame_taken;
  uint64_t last_released;
  hvir_terminal_renderer_info renderer_info;
  uint64_t requested_mutation, io_applied_mutation;
  uint32_t input_failure;
  struct hvir_input_capture *input_capture;
};
struct hvir_terminal_host {
  pthread_t caller;
  pthread_mutex_t events;
  pthread_cond_t changed;
  terminal_state *states;
  ghostty_app_t app;
  void *display;
  hvir_linux_display *owned_display;
  uint32_t initial_presentation_mode;
  bool closing;
  uint64_t next_id, next_lease;
  int (*init)(uintptr_t, char **);
  ghostty_config_t (*config_new)(void);
  void (*config_free)(ghostty_config_t);
  void (*config_finalize)(ghostty_config_t);
  ghostty_app_t (*app_new)(const ghostty_runtime_config_s *, ghostty_config_t);
  void (*app_free)(ghostty_app_t);
  void (*app_tick)(ghostty_app_t);
  void (*surface_free)(ghostty_surface_t);
  ghostty_surface_t (*external_new)(ghostty_app_t, void *, const hvir_ghostty_external_config *,
                                    uint32_t, uint32_t);
  bool (*external_input_capacity)(ghostty_surface_t, const hvir_ghostty_input_event *, bool, size_t *);
  uint32_t (*external_input)(ghostty_surface_t, const hvir_ghostty_input_event *, uint64_t, bool, size_t, hvir_ghostty_input_result *);
  bool (*external_feed)(ghostty_surface_t, const uint8_t *, size_t, uint64_t);
  bool (*external_frame_release)(ghostty_surface_t);
  bool (*external_presentation_mode)(ghostty_surface_t, uint32_t);
  bool (*external_resize)(ghostty_surface_t, uint32_t, uint32_t, uint64_t, double);
  void (*surface_visibility)(ghostty_surface_t, bool);
  bool (*external_read)(ghostty_surface_t, uint8_t *, size_t, size_t *);
  bool (*external_key)(ghostty_surface_t, int, uint32_t, int, const uint8_t *, size_t, uint8_t *,
                       size_t, size_t *);
};

hvir_terminal_result hvir_internal_owner(hvir_terminal_host *);
terminal_state *hvir_internal_lookup(hvir_terminal_host *, uint64_t);
hvir_terminal_result hvir_internal_state(hvir_terminal_host *, uint64_t, terminal_state **, bool);
bool hvir_internal_input(void *, uint32_t, const uint8_t *, size_t);
void hvir_internal_mutation_applied(void *, uint64_t);
#endif
