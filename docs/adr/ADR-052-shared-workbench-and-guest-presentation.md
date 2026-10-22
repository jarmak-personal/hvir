# ADR-052: Shared workbench and guest presentation

> Lifecycle: Active

## Context

Directory extensions need useful list/detail and small clock presentation without copying
private workbench components. Existing theme styles combine semantic values, feature-specific
light treatment, and shell behavior. Publishing those selectors would expose private structure.

## Decision

A browser-safe shared presentation owner supplies semantic tokens and class-based primitives
for panels, toolbars, controls, labeled fields, rows, metadata, states, focus and scrolling.
Built-in React views consume those classes; feature styles retain layout and specialized
presentation through semantic tokens. Pane resizing, fixed terminal/graph-lane/highlighter
palettes, trusted confirmation, placement and scrollbar-overlay lifetimes remain privately
owned. Semantic change emphasis, selection, JSON syntax roles and Markdown, CSV and image
presentation belong to the shared tokens.
The renderer's explicit style manifest retains cascade ordering.

The existing theme and typography settings owners retain preferences and persistence.
The extension presentation contract carries the shared semantic colors, interface font,
monospace font, scale and available dimensions directly. Values are bounded presentation data,
not authority. The trusted renderer resolves CSS colors before publication; main validates the
closed vocabulary and values before forwarding them through the existing guest bridge.

The optional kit is plain CSS and browser JavaScript. A package preparation command copies
its ready-to-use assets from the shared owner into an ordinary package; immutable revision
capture then owns those bytes. No author build, remote asset, font service or framework is
required. Updating hvir changes supplied token values, not a captured package's primitive rules.
The named list/detail example needs only ordinary DOM events and keyboard list navigation.
Custom guest presentation continues to use the same public bridge without the kit.

Shared presentation depends only on public presentation data and browser interfaces. It cannot
import main, workers, private renderer/preload, or package implementations, including types.
Workbench consumers depend inward on this owner. Existing dependency enforcement owns the
focused direction rule; ordinary source budgets apply without exceptions.

A guest-local binding owns its bridge subscription and handlers. Disposal first revokes its
local generation, then unsubscribes and removes handlers; late updates cannot change the DOM
or restore listeners. Host requests remain explicit public-bridge operations. Kit controls
never act as trusted permission surfaces or acquire filesystem/native/session authority.

## Consequences

Workbench and guest controls share maintained presentation, while private feature structure
and isolated guest lifetimes remain independent. Captured assets prevent an update silently
replacing package control behavior. Semantic names become part of the released contract.
Feature-specific presentation cannot be represented by a speculative public widget catalog;
new public primitives require evidence from a supported consumer.

## Rejected alternatives

- Exporting private React components or workbench styles couples extensions to internal layout.
- A separately maintained kit stylesheet drifts from the workbench.
- Live application stylesheet URLs change captured package appearance and expose private selectors.
- A framework migration, CDN or author build requirement prevents simple offline packages.
- A UI schema or trusted guest dialog broadens presentation into platform authority.
