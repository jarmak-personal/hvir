# Renderer responsiveness diagnostic evaluation

This document records the bounded experiment authorized by ADR-016. It is a diagnostic
contract and product recommendation, not a responsiveness SLA: Chromium Long Tasks are
low-confidence evidence that the renderer main thread was occupied, not proof that hvir caused
a user-visible failure.

## Detector contract

| Concern | Contract |
| --- | --- |
| Owner and process | The renderer-owned detector observes Chromium timing entries. The main-owned `ResponsivenessDiagnosticSessions` coordinator qualifies the exact renderer generation, bounds the run, aggregates evidence, and owns deletion. |
| Modes | Available only when `app.isPackaged` is false. It starts only from the visible **Start responsiveness diagnostics** action. Ordinary packaged use does not expose or run it. |
| Preconditions | The pinned Electron 43 / Chromium runtime must expose `PerformanceObserver` and the `longtask` entry type. Event Timing is optional correlation evidence. Missing or changed APIs leave a visible unavailable state or stop the run as `api-unavailable`; they do not affect product behavior. |
| Observation and threshold | A visible renderer task lasting at least 100 ms is eligible after a one-second session warmup. Event Timing entries are used only to classify an overlapping interval as `input-paint-delay`; event names and input values are never read or retained. |
| Severity and product effect | Every retained episode is informational, low-confidence diagnostic evidence. No episode opens workbench health, raises ADR-009 attention, reloads a renderer, or changes terminal behavior. |
| Episode aggregation | Renderer entries separated by at most one second settle into one observation. Main combines observations into at most one aggregate per 30-second owner/session window. A conservative merge becomes `unattributed` if any contributing observation lacks input/paint correlation. |
| Deduplication and resolution | A main window emits on 30-second rollover or on `user-stop`, `timeout`, `backgrounded`, or `api-unavailable`. Renderer rollover revokes the run and deletes its evidence instead of emitting an immediately ownerless record. There is no automatic recovery. Repeated Stop/Delete is harmless, and a new run deletes the prior retained run. |
| Safe schema | A stored aggregate contains only the renderer generation, opaque session/correlation IDs, count, saturated dropped count, timing bucket, classification, confounder enum, first/last ISO times, and resolution. It contains no task attribution, stack, URL, path, DOM, selector, text, input type/value, terminal data, or screenshot. |
| Rate and size | The preload path shares #89's four-observations-per-second token bucket, burst 16, queue 64, and batch 16. The main run accepts at most 512 observations and 30 aggregates over 15 minutes. Stored aggregates are at most 512 bytes and arrive at most once per 30 seconds; overload drops evidence rather than delaying the renderer. Session evidence remains memory-only until the user explicitly creates a temporary reviewed report, so Delete removes the complete run. |
| Runtime cost | The detector installs one Long Tasks observer, optionally one Event Timing observer, one visibility listener, and a settle timer only while active. It performs no filesystem, DOM traversal, forced layout, continuous sampling, or synchronous main-process round trip. Stop, timeout, backgrounding, API loss, renderer rollover, and Delete disconnect observers and timers. |
| Test altitude | Pure tests own thresholding, grouping, conservative classification, queue/rate/capacity, schema rejection, timeout, deletion, and late-generation behavior. The production-composed Electron workflow owns real Long Tasks fault injection and exact report output. The #72 capacity scenario compares disabled and active 15-second phases under 12 terminals and reports CPU, memory, event count, frame p99/max, and click p95/max on Linux and macOS ARM64. |

## Confounders and omissions

- Startup entries during the first second of a run are omitted. This is session warmup, not an
  attempt to infer application startup completion.
- A hidden/backgrounded document ends the run and records that resolution; it does not retain
  throttled background entries.
- Sleep produces no synthetic episode. A run that crosses its 15-minute wall-clock bound times
  out on resume; otherwise later unattributed entries remain explicitly confounded.
- DevTools, garbage collection, OS scheduling, and other runtime contention cannot be reliably
  separated with the safe APIs used here. Uncorrelated work is therefore classified
  `unattributed` with `runtime-or-environment`, never blamed on hvir.
- Event Timing is incomplete: programmatic work, unsupported event types, compositor work, GPU
  stalls, short repeated tasks, and delays outside the renderer main thread can be missed. An
  overlapping event can also be coincidental. These are accepted false negatives and false
  positives for an opt-in diagnostic aid.

## Evaluation and recommendation

The experiment answers a narrow question: “During a user-requested diagnostic window, did the
visible renderer accumulate coarse main-thread occupancy that is useful beside other reviewed
evidence?” The deterministic Electron fixture proves the pinned runtime can produce, group,
preview, copy, and delete such evidence without changing health. The permanent capacity
comparison keeps the observer inside #72's owning performance evidence instead of inventing a
parallel benchmark. Hosted runs label the disabled/active comparison as machine-dependent
evidence; the same budgets become blocking only through the documented controlled-machine
`npm run performance:capacity` command.

Retain this detector as opt-in development diagnostics. Promote no Long Tasks-derived signal to
always-on packaged health. Even input/paint overlap does not identify the cause, and the added
confidence is insufficient to justify persistent instrumentation or a user-facing fault verdict.
No promotion issue is warranted from this evaluation. Reconsider only if a separately aligned
problem identifies a higher-confidence production event and the Linux/macOS capacity evidence
continues to meet ADR-016's cost budgets.
