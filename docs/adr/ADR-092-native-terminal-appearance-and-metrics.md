# ADR-092: Native terminal appearance and measured metrics

> Lifecycle: Active

## Context

hvir owns terminal palettes, typography, ligatures and cursor defaults. Native rendering
needs those same settings without importing Ghostty's application configuration or
replacing a live PTY. An accepted configuration command is not an acknowledgement that
native IO applied it, and a font change can invalidate geometry before a resize completes.

## Decision

Map the existing settings owners into one bounded, typed native appearance snapshot.
The adapter accepts font families and size, shaping, cursor defaults, the complete hvir
palette and its displayed dark/light classification. It grants no free-form configuration,
commands, keybindings, clipboard, file-image media or Ghostty application authority.
Native reload preserves the external-stream restrictions used at initial creation.
Application cursor requests remain authoritative over local defaults.

Apply appearance on the designated native caller with an explicit configuration serial
and IO mutation fence. Report success only for that applied serial; superseded settings,
replaced attachments and revoked owners reject late completion. An uncertain partial
native configuration failure fails the affected state through its existing failure owner.
It cannot certify a healthy mixture of old and new configuration.

Palette and cursor changes update native presentation and query replies while retaining
valid geometry, search and extraction identities. Typography and shaping changes revoke
the presentation/input grant before mutation. Layout waits for their configuration fence,
then uses measured native font metrics and the existing applied-resize serial before
publishing a new grant or notifying the PTY. Display scale follows the same geometry path.
A configuration acknowledgement certifies native application, not physical presentation.

Separate frame authority from the WebGL context owned by an attached renderer view.
An explicit visible geometry or typography refit may retain that context only for the
same native epoch and attachment while revoking its frame grant immediately. Suspend
old pixels until a newly issued geometry grant and a matching frame draw; the resume
floor is the highest issued geometry serial, including grants not yet drawn. Retention
holds no imported frame, VideoFrame, input authority or extra import credit.

Unhinted revocation, hiding, unmounting, failure and identity replacement dispose the
context. Context loss is bound to the exact canvas lifetime and remains latched during
a refit gap. A failed refit strongly revokes and occludes; a lost retained context cannot
resume on a new grant and instead acknowledges that newly issued grant through the
existing failure path. No grace timer or second authority registry is introduced.

Carry the same bounded snapshot with initial viewport preparation so native configuration
and measured initial geometry precede PTY launch. Hidden terminals retain native state and
accept settings without a new PTY; reveal acknowledges their current measured geometry.
Settings remain owned by the existing runtime and palette owners, without a second bus.
Retained queries keep their finite-pass cutoff and dirty-wake lifetimes; appearance adds
neither output-quiescence gating nor query idle polling.

Keep named-family availability and alias resolution in native discovery. Regular
Fontconfig requests retain the requested family first and append the native monospace
generic before host default substitution. Available custom families, including deliberately
proportional choices, retain priority. The adapter supplies regular families; native
collection style completion derives its default bold and italic faces from that primary.
Codepoint-only and emoji discovery retain their existing fallback paths.

## Consequences

Font discovery, fallback, shaping and cell metrics remain native engine responsibilities.
The renderer maps product settings and layout; it does not estimate native cells using
prototype constants. Typed configuration and its failure fence become part of the pinned
private ABI and must be reproduced with its native source and bindings.

## Rejected alternatives

- Loading arbitrary user Ghostty configuration or creating another settings UI.
- Treating configuration enqueue or an old resize acknowledgement as completion.
- Rebuilding fonts for palette-only updates or preserving stale typography geometry.
- Restarting the PTY to apply settings or waiting for terminal output to become idle.
- Recreating a healthy WebGL context solely because a visible refit revoked frame authority.
