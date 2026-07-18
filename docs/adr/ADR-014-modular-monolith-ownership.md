# ADR-014: Modular monolith ownership and dependency discipline

## Context

hvir's public seams already express its product architecture, but large entry points and
feature components accumulated unrelated state, effects, workflows, and resource
lifecycles. Splitting by line count alone would move rather than remove that coupling.

## Decision

hvir remains a modular monolith within its Electron renderer, main, and worker process
boundaries. Within each process, organize by product capability. Entry points construct,
wire, start, and dispose explicit owners; they do not implement product workflows.

Dependency direction points inward toward stable policy and ports:

- Shared contracts and host-qualified values import no main, renderer, or worker code.
- Electron/bootstrap adapters depend on application coordinators; coordinators depend on
  narrow capability ports; concrete ProjectHost, PTY, provider, Git-worker, preview, and
  web-pane adapters implement those ports at the edge.
- Feature IPC registrars are transport adapters behind one authority router. They validate
  and translate their feature's messages, then call application services; sibling-feature
  coordination and direct ambient `ipcMain` imports are prohibited.
- The renderer shell composes feature models/controllers and views. Pure reducers,
  selectors, planners, and policies import neither React nor preload. Effect hooks own
  subscriptions and narrow typed ports; views receive state and events.
- Worker entry points dispatch typed messages to stable facades. Capability modules share
  runner, root validation, cancellation, and error policy rather than acquiring authority.

Resource ownership is hierarchical and typed. Application, renderer owner/generation,
project, host-qualified workspace, tab/pane/session, and request generation are distinct
qualifiers. Revocation rejects late async completion; disposal is idempotent and runs in
reverse ownership order. Durable recovery records, live PTYs, web routes, previews,
attention, SSH authentication/prompts, watches, and refreshes each retain the specialized
owner named by their public seam rather than sharing a blanket renderer lifetime.

Cross-feature workflows live in explicitly named coordinators that receive narrow ports.
Public facades—`ProjectHost`, `TerminalPane`, the PTY supervisor, harness providers, and
`GitEngine`—remain stable while consumers may use smaller internal ports. Generic `utils`,
catch-all `services`, service locators, policy inside IPC/bootstrap, root-owned renderer
feature state, and adapter details in consumers are prohibited.

Styles are feature-owned. The renderer root declares the complete ordered cascade through
an explicit import manifest; only base tokens and documented cross-feature primitives may
remain shared. Component mount/import order cannot determine precedence.

Architecture hotspot budgets and authority/seam checks are blocking in normal verification.
Budgets are non-growth ratchets and review signals, not substitutes for ownership review.
Production, test/smoke, and generated files have separate policy; every exception names an
owner, rationale, expiry, and removal issue.

Tests run at the seam owned by the behavior. Pure policy receives direct unit coverage;
feature consumers fake their narrow ports; adapters fake only immediate external
dependencies while asserting public security, failure, and resource semantics. Electron,
Chromium, cross-process, renderer-destruction, and real-transport contracts remain at
integration, smoke, or real-host altitude.

## Consequences

Ownership and dependency review follow product capabilities rather than framework layers or
file length. Pure policy becomes cheap to exercise, effectful contracts remain tested where
their environment is real, and late work cannot silently widen authority. The discipline
requires explicit composition and disposal code, narrow types, and occasional coordinators,
but no new state framework, DI framework, plugin platform, or process boundary.

## Rejected alternatives

- Redux, Zustand, or another global renderer store for feature- and workspace-specific state.
- A dependency-injection framework or service locator.
- Generic `utils`/`services` buckets or splits made only to satisfy line counts.
- A plugin system or new process boundary for the behavior-preserving architecture.
- Testing Electron and transport lifecycle only through mocks.
- A long-lived big-bang rewrite that prevents independent review and weakens seam coverage.
