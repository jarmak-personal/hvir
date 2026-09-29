# ADR-046: React-owned development measure containment

> Lifecycle: Active
> Supersedes: [ADR-025](ADR-025-remove-renderer-responsiveness-diagnostic.md) | partial | Requirement to preserve hvir's development Performance Timeline containment owner and budget fixture.

## Context

ADR-025 preserved a development-only owner that periodically counted React measures in the
browser's Performance Timeline and cleared all measures after an 8,192-entry budget. Its focused
Electron fixture deliberately produced enough React work to exceed that budget and prove hvir's
timer returned the retained collection below it.

React 19.3 clears each potentially large development measure immediately after recording it.
That upstream lifecycle addresses the same Chromium memory-retention risk and makes hvir's timer,
budget, document data attributes, and timer lifecycle tests duplicate policy. The old fixture can
no longer distinguish successful upstream cleanup from a workload that produced no measures,
because both leave the retained timeline empty.

The Performance Timeline provides a separate browser observation path: a registered
`PerformanceObserver` receives entries queued when they are recorded even if their retained
timeline entries are subsequently cleared. That browser contract can prove the workload and the
retained bound independently without product instrumentation.

## Decision

React owns containment of its development Performance measures. hvir does not count, budget,
periodically inspect, or clear those measures.

Preserve one focused development Electron scenario as a dependency-compatibility contract. The
scenario registers a browser `PerformanceObserver` before requesting repeated React rendering,
proves that fixture-specific React measures were observed, and separately proves that no measures
remain in the Performance Timeline after the workload completes. The observer belongs only to the
scenario and disconnects when that bounded observation ends.

The renderer retains only the development-only, event-triggered hidden React fixture needed to
produce real work. Its request listener and render resources remain disposable with the renderer
lifetime. Production bundles reject the fixture marker and gain no observer, timer, diagnostic
event, health policy, or telemetry.

This supersedes only ADR-025's requirement to preserve hvir's prior containment owner and budget
fixture. ADR-025's removal of renderer-responsiveness diagnostics and its remaining independent
capacity and workbench-health boundaries stay in force.

## Consequences

Development sessions no longer run a periodic measure inspection timer or expose measure-policy
data attributes. React upgrades that change measure generation or retention fail at the real
Chromium boundary instead of being masked by hvir cleanup. The focused scenario depends on
React's development measure names and the browser's observer semantics, so an upstream change
requires an explicit compatibility assessment rather than a weaker assertion.

hvir no longer supplies an independent fallback if React regresses its cleanup. Reintroducing a
runtime containment owner requires evidence that upstream lifecycle ownership is insufficient
and a new decision defining non-duplicative authority.

## Rejected alternatives

- Keep hvir's timer as defense in depth; two owners would obscure an upstream regression and
  retain a no-op development lifecycle.
- Assert only that the retained timeline is empty; a missing or broken React workload would
  produce the same result.
- Monkey-patch `performance.measure` or `clearMeasures`; replacing browser methods would create a
  test-only execution path instead of observing the real Chromium contract.
- Add packaged monitoring or workbench-health policy; development dependency compatibility is
  not a user-facing responsiveness signal.
