#include "terminal_internal.h"
#include <stdlib.h>
#include <string.h>

#define EFFECT_BYTES (1024u * 1024u)
#define EFFECT_PART 65536u

/* The parser owns callback bytes. Only this copied storage crosses its return. */
static void forget_effect(terminal_state *s, queued_effect *e) {
  s->effect_bytes -= e->length + e->extra_length;
  free(e->data);
  memset(e, 0, sizeof(*e));
}
void hvir_internal_clear_effects(terminal_state *s) {
  for (size_t i = 0; i < 3; i++) forget_effect(s, &s->latest[i]);
  for (size_t i = 0; i < 128; i++) forget_effect(s, &s->events[i]);
  memset(s->latest_pending, 0, sizeof(s->latest_pending));
  s->event_count = s->event_start = 0;
}
static void dropped(terminal_state *s) {
  if (s->dropped_effects != UINT64_MAX) s->dropped_effects++;
  if (s->semantic_generation != UINT64_MAX) s->semantic_generation++;
}
bool hvir_internal_effect(void *userdata, const hvir_ghostty_external_effect *event) {
  terminal_state *s = userdata;
  if (!event) return false;
  pthread_mutex_lock(&s->host->events);
  if (s->closing || s->failure) {
    pthread_mutex_unlock(&s->host->events);
    return false;
  }
  if (event->kind == 11) {
    dropped(s);
    pthread_mutex_unlock(&s->host->events);
    return true;
  }
  if (event->kind == 8 && s->semantic_generation != UINT64_MAX) s->semantic_generation++;
  const size_t total = event->data_len + event->extra_len;
  size_t slot = event->kind >= 1 && event->kind <= 3 ? event->kind - 1 : 3;
  queued_effect *target = slot < 3 ? &s->latest[slot]
    : &s->events[(s->event_start + s->event_count) % 128];
  bool valid = event->data_len <= EFFECT_PART && event->extra_len <= EFFECT_PART &&
    (!event->data_len || event->data) && (!event->extra_len || event->extra) &&
    total <= EFFECT_BYTES - s->effect_bytes && (slot < 3 || s->event_count < 128);
  uint8_t *copy = valid && total ? malloc(total) : NULL;
  if (!valid || (total && !copy)) {
    dropped(s);
    pthread_mutex_unlock(&s->host->events);
    return true; /* Refused side effect never makes terminal parsing unusable. */
  }
  if (event->data_len) memcpy(copy, event->data, event->data_len);
  if (event->extra_len) memcpy(copy + event->data_len, event->extra, event->extra_len);
  if (slot < 3) forget_effect(s, target);
  *target = (queued_effect){.kind = event->kind, .action = event->action,
    .screen = event->screen, .row = event->row, .column = event->column,
    .sequence = event->sequence, .event_serial = event->serial,
    .length = event->data_len, .extra_length = event->extra_len, .data = copy};
  s->effect_bytes += total;
  if (slot < 3) s->latest_pending[slot] = true;
  else s->event_count++;
  pthread_cond_broadcast(&s->host->changed);
  pthread_mutex_unlock(&s->host->events);
  return true;
}
hvir_terminal_result hvir_terminal_effects_status(hvir_terminal_host *h, hvir_terminal_id id,
  hvir_terminal_effect_status *out) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, true);
  if (result) return result;
  if (!out) return HVIR_INVALID;
  pthread_mutex_lock(&h->events);
  *out = (hvir_terminal_effect_status){s->dropped_effects, s->semantic_generation, s->effect_bytes};
  pthread_mutex_unlock(&h->events);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_next_event(hvir_terminal_host *h, hvir_terminal_id id,
  hvir_terminal_event *out) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, true);
  if (result) return result;
  if (!out) return HVIR_INVALID;
  pthread_mutex_lock(&h->events);
  queued_effect *event = NULL;
  /* Select the oldest surviving occurrence across coalesced and FIFO records. */
  for (size_t i = 0; i < 3; i++)
    if (s->latest_pending[i] && (!event || s->latest[i].event_serial < event->event_serial))
      event = &s->latest[i];
  queued_effect *front = s->event_count ? &s->events[s->event_start] : NULL;
  if (front && (!event || front->event_serial < event->event_serial)) event = front;
  if (!event) { pthread_mutex_unlock(&h->events); return HVIR_BUSY; }
  *out = (hvir_terminal_event){.kind = event->kind, .action = event->action,
    .screen = event->screen, .row = event->row, .column = event->column,
    .sequence = event->sequence, .event_serial = event->event_serial,
    .length = event->length, .extra_length = event->extra_length};
  if (event->length) memcpy(out->data, event->data, event->length);
  if (event->extra_length) memcpy(out->extra, event->data + event->length, event->extra_length);
  if (event == front) { s->event_start = (s->event_start + 1) % 128; s->event_count--; }
  else for (size_t i = 0; i < 3; i++) if (event == &s->latest[i]) s->latest_pending[i] = false;
  forget_effect(s, event);
  pthread_mutex_unlock(&h->events);
  return HVIR_OK;
}
hvir_terminal_result hvir_terminal_link(hvir_terminal_host *h, hvir_terminal_id id,
  const hvir_terminal_link_query *query, uint8_t *out, size_t capacity, size_t *written) {
  terminal_state *s;
  hvir_terminal_result result = hvir_internal_state(h, id, &s, false);
  if (result) return result;
  if (!query || !out || !written || query->screen > 1 || capacity > EFFECT_PART) return HVIR_INVALID;
  *written = 0;
  pthread_mutex_lock(&h->events);
  bool current = s->requested_geometry == s->geometry.serial && !s->geometry_failure_serial &&
    s->requested_mutation == s->io_applied_mutation && s->applied_sequence == query->sequence &&
    s->geometry.serial == query->geometry && s->io_applied_mutation == query->mutation;
  pthread_mutex_unlock(&h->events);
  if (!current) return HVIR_BUSY;
  return (hvir_terminal_result)h->external_link(s->surface, query->row, query->column,
    query->screen, query->sequence, query->mutation, query->geometry, out, capacity, written);
}
