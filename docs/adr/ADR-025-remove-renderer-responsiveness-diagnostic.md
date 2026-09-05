# ADR-025: Remove the renderer-responsiveness diagnostic

> Lifecycle: Active
> Supersedes: [ADR-016](ADR-016-bounded-local-runtime-diagnostics.md) | partial | Responsiveness episode candidate and its opt-in renderer diagnostic experiment.

## Context

ADR-016 admitted one low-confidence exception to hvir's bounded runtime diagnostics: an
explicit, development-only renderer session that observed Chromium Long Tasks and optional
Event Timing correlation. The experiment remained off in packaged builds, never affected
workbench health, and retained evidence only for a reviewed diagnostic report.

The experiment produced no recorded actionable diagnosis after the self-observing UX work
landed. Its acceptance comparison observed no ordinary-interaction episodes, and unrelated
capacity outliers were diagnosable without it. Retaining the experiment nevertheless requires a
renderer detector and controls, preload batching, main-owned session policy, IPC contracts,
report schema, focused lifecycle tests, and an active-versus-disabled phase in every capacity
run. That permanent surface is disproportionate to its demonstrated value.

## Decision

Remove the opt-in renderer-responsiveness diagnostic without replacing it with another runtime
detector or disposable Long Tasks fixture. hvir no longer observes Long Tasks or Event Timing,
offers a responsiveness recording session, transports or aggregates those observations, or
includes a renderer-responsiveness event in diagnostic reports.

Remove the diagnostic-specific active-versus-disabled capacity comparison and its budgets.
Preserve the independent capacity contracts for terminal topology, activity and readiness,
loaded frame and click latency, process metrics, working-set growth, and controlled-machine
performance verdicts. Preserve the development Performance Timeline containment fixture: it
bounds development-only React measures and is not a responsiveness signal or report source.

Electron's high-confidence `unresponsive` lifecycle event remains an always-on window-manager
fault under ADR-016. This decision supersedes only ADR-016's `Responsiveness episode` candidate
and the retention recommendation in the historical renderer-responsiveness evaluation. All
other ADR-016 diagnostic ownership, data, trust, lifecycle, and reporting boundaries remain in
force.

## Consequences

Development builds lose the manual Start, Stop, and Delete responsiveness controls, and reviewed
reports reject the removed event kind. The preload, main diagnostics owner, IPC contract, and
capacity scenario become smaller, while ordinary workbench health and report behavior are
unchanged.

hvir no longer has coarse Long Tasks evidence for an ad hoc renderer investigation. Maintainers
continue to use focused Electron fixtures, the capacity suite, Chromium tooling, and the
window-manager's high-confidence lifecycle events at their respective boundaries. Reintroducing
runtime renderer instrumentation requires a new aligned problem and decision with evidence that
the signal changes diagnosis or action; this removed experiment is not a dormant extension seam.

## Rejected alternatives

- Retain the complete opt-in vertical slice in case it becomes useful; speculative future value
  does not justify permanent product, schema, lifecycle, and CI surface.
- Keep only a disposable Long Tasks fixture; no concrete diagnostic question currently needs the
  low-confidence signal, while the independent capacity and development-containment fixtures
  already own their useful contracts.
- Promote Long Tasks to packaged workbench health; the signal cannot attribute causality and was
  never accepted as a product fault verdict.
