# ADR-084: Isolated Mermaid rendering

> Lifecycle: Active

## Context

Mermaid requires browser DOM and layout APIs. Its layout can block workbench input
and painting; awaiting its result does not move that work off the renderer thread.
Source-size limits alone do not bound layout across its supported diagram families.

## Decision

Run Mermaid layout outside the trusted workbench in a separate sandboxed browser
renderer, behind a finite viewer-owned rendering port. The computation page has no
project, filesystem, or general application IPC authority. Main owns authenticated
request admission and browser-process lifetimes; viewer policy remains independent
of React, preload, and concrete Electron adapters.

Each running job has its own disposable renderer. Cancellation, deadline expiry,
crash, and owner revocation discard that renderer and reject late delivery. Every
replacement establishes process separation before receiving document content.
Only bundled computation assets are admitted. Bounded passive SVG returns through
a narrow data channel and receives independent admission before workbench insertion.

Markdown/CSV application and position capture remain bounded under the existing
viewer owner. Unsupported workloads receive visible fallback while preserving the
selected mode and access to Source. This boundary is specific to finite Mermaid
computation; ADR-014's rejection of new processes for behavior-preserving
restructuring does not establish or remove authority for other process boundaries.

## Consequences

Broad Mermaid support retains its browser environment without monopolizing the
workbench thread. An extra process and bundled entry point cost memory and startup
time. Finite admission, cancellation, output safety, and disposal require real
Electron evidence; isolation alone does not bound resource use or SVG mounting.
Local and SSH documents share the same content-only rendering path.

## Rejected alternatives

- Layout in the workbench: promises and source limits cannot prevent synchronous stalls.
- An ordinary worker or utility process: neither provides browser layout APIs.
- A handcrafted Mermaid subset: duplicates grammar policy and removes useful formats.
- Live diagram surfaces or reuse of HTML/extension/web-pane authorities: introduces
  unrelated interaction, authority, and resource lifetimes into finite computation.
