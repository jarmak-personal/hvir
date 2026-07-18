# ADR-003: Terminal is a swappable pane, not the foundation

## Context

The terminal is central to hvir's workflow, but Ghostty's native embedding API is still a
moving dependency. Application layout, navigation, and file authority must not depend on
one terminal engine or its widget lifecycle.

## Decision

All terminal rendering lives behind a `TerminalPane` interface. Use `ghostty-web` for the
primary terminal implementation and retain xterm.js as a compatible fallback. Reconsider
a native libghostty widget only after its Linux embedding API is versioned and stable.

Terminal focus mode is transient application layout state owned by the viewer/terminal
divider. It expands the active terminal without persisting a second layout, unmounting
viewer tabs, or unmounting PTYs. Any intentional file activation restores the viewer.

Terminal file links cross the seam as typed, user-activated path events. The renderer
resolves them against the terminal's host-qualified workspace root, accepts absolute
paths only within that root, and routes the resulting `HostPath` through the ordinary
viewer-open path. Link text is never executed. Engine-specific path recognition and OSC
handling remain inside `TerminalPane`.

## Consequences

Terminal engines can be replaced without changing product layout, PTY ownership, file
navigation, or recovery. Engine resize and event quirks remain adapter concerns. The
native Ghostty path stays open, but hvir does not depend on an unstable native API.

## Rejected alternatives

- Making native libghostty a foundational dependency before its embedding contract is
  stable.
- Letting terminal implementations own React layout or filesystem authority.
- Persisting focus mode as the divider height or unmounting viewers and PTYs while focused.
- Allowing terminal links outside the active workspace or executing path-like text.
