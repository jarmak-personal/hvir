# ADR-009: Focus clears attention and parents aggregate

> [ADR-019](ADR-019-working-output-is-not-actionable-attention.md) supersedes only
> the treatment of ongoing post-submission output as new attention and its inclusion
> in workspace and project rollups. The remaining decisions still apply.

## Context

Users need to know which agent terminal requires attention without permanent noise from
streaming output or hidden special cases at active parent levels.

## Decision

A terminal's attention clears only when that terminal is focused. Workspace and project
parents aggregate unseen child terminals; focusing a parent does not clear its children.
Signal priority is idle-after-user-submission, explicit bell, then new output since focus.
Idle is armed by a user submission boundary and may raise Ready once when that turn first
becomes quiet; startup, recovery, repaint, and periodic control output do not manufacture
new turns.

The OS badge quietly counts distinct terminals with unseen idle or bell attention only
while all hvir windows are unfocused. Focusing any hvir window clears the OS aggregate but
not terminal attention. Unsupported desktop badge mechanisms fail silently. No sound,
toast, bounce, flash, or urgency fallback is used.

Connection status, Git changes, and terminal attention use distinct shapes, placement,
labels, and accessible text. A terminal shows its strongest unseen signal; parents show
the count of unseen child terminals. Color is secondary.

## Consequences

The model has one visible clearing rule across terminals, workspaces, and projects. The
active project may legitimately show attention from a non-focused child. Generic input,
output, idle, bell, title, and exit events remain provider-independent.

## Rejected alternatives

- Suppressing rollups on an active parent or clearing children when only a parent focuses.
- Treating every PTY write as a new turn or parsing harness prompts and screen contents.
- Counting ambient output in the OS badge or incrementing once per event.
- Color-only distinctions or reusing connection and Git indicators for attention.
- Sounds, toasts, Dock bouncing, flashing windows, and Linux urgency fallbacks.
