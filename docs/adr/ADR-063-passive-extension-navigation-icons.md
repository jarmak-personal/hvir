# ADR-063: Passive accepted-revision extension navigation icons

> Lifecycle: Active

## Context

An optional package-owned symbol can make an existing navigation destination recognizable
without replacing its text, keyboard operation or selected state. The trusted workbench must
not execute package markup or read unaccepted mutable assets to display that symbol. The
existing guest protocol is confined to a particular guest session and is not a workbench
asset-serving route. ADR-054 remains authoritative for package and capability isolation.

## Decision

Permit an optional `navigationIcon` package-relative SVG path on a navigation contribution.
Existing manifest validation owns the declaration; existing capture owns its exact bytes and
revision, and contribution publication owns its activation-qualified display data. Core has
no package-specific artwork or imports. Older hosts may ignore this decorative declaration;
it conveys no capability or authority, and the text destination remains usable.

Support a deliberately small static SVG path vocabulary, not general SVG documents. Capture
validates finite small UTF-8 bytes, an explicit finite view box and nonempty bounded path
geometry with closed paint/line attributes. Reject scripts, event handlers, XML entities or
DTDs, processing instructions, styles, animation, foreign content, links, external resources
and unsupported markup. Reconstruct a passive image from validated data rather than passing
arbitrary SVG markup to the renderer. A missing, malformed, unsupported or oversized icon
reports a bounded package warning and retains text navigation; it does not invalidate the
whole otherwise valid package.

Publish only bounded passive mask data derived from the accepted captured revision. The
trusted navigation renderer uses it as a CSS image mask painted with its own current text
color; it never inserts package SVG into its document. Validation occurs off the render
thread during existing bounded package capture. No new protocol, external loader, image
service, executable package path or permission is introduced. Existing labels, accessible
names, keyboard focus, selected state and contribution placement remain authoritative.

Icon data has the contribution snapshot's lifetime. Disable, replacement and removal retire
the activation before publication; a late snapshot cannot restore a removed destination.
No object URL, guest, updater, refresh timer or independent resource owner is allocated for
an icon. Replacing mutable source bytes requires the existing explicit accepted-revision
flow before those bytes can appear in navigation.

## Consequences

Navigation stays useful when decorative assets fail, and passive masks follow light/dark
appearance and interface scale without package execution. The intentionally narrow static
vocabulary refuses complex SVG artwork with an achievable instruction to use simple paths.
Bounds and failure warnings belong to the existing package validation owner. Terminal glyph
contracts, unrelated viewer-tab markers, project authority and guest rendering are unchanged.

## Rejected alternatives

- Inline package SVG or HTML in the trusted renderer widens executable markup authority.
- Reusing the guest protocol conflates guest-session assets with trusted workbench requests.
- Reading mutable package files at paint time breaks exact accepted-revision identity.
- A new general icon framework, XML engine, protocol or resource registry exceeds a small
  optional decorative edge; a new dependency is unnecessary for its closed data vocabulary.
- Removing text or disabling navigation when an icon fails makes decoration a prerequisite.
