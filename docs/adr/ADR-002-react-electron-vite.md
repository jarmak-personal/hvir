# ADR-002: React on electron-vite for the render layer

## Context

The renderer must assemble a polished viewer, tree, Git surfaces, terminals, dialogs,
and layout controls quickly while retaining clear Electron main/preload/renderer
boundaries.

## Decision

Use `electron-vite` for the Electron build and React for the render layer. Keep heavy
work outside React and the render thread; React composes feature-owned models and views.

## Consequences

The project benefits from the largest relevant component ecosystem and familiar testing
and composition patterns. Responsiveness depends on disciplined ownership, narrow ports,
and worker or main-process execution rather than framework-level reactivity savings.

## Rejected alternatives

Svelte and Solid have lighter runtimes, but their smaller ecosystem would require more
hand-built viewer and desktop UI infrastructure. That trade does less for perceived
responsiveness than keeping expensive work off the render thread.
