# ADR-058: Explicit command-once terminal handoff

> Lifecycle: Active
> Supersedes: [ADR-012](ADR-012-harness-providers-launch-profiles.md) | partial | Explicit fresh ordinary-shell command handoff only; persistent profiles, trusted providers, protected environment, and exact harness recovery remain unchanged.

## Context

A user may explicitly open CLI-owned setup in a new terminal without creating a persistent
command profile, injecting into an existing PTY, or replaying setup during recovery. A default
shell with typed startup input is timing-dependent. Shell-specific interactive evaluation also
changes argument semantics and can race startup files. The extension must hand terminal control
to the ordinary terminal owners rather than retain process authority.

## Decision

Expose a narrow, negotiated fresh-terminal capability. Its declared capability and operation-scoped
terminal grant are separate from an existing finite native connector approval; no additional
durable Settings terminal permission is introduced. Main binds each
admission to its exact caller class and admitted action authorization, activation, canonical
approved executable, prefix arguments, configuration, and host-qualified workspace. A trusted human launch decision names the actual command and destination and grants only that
one terminal handoff. Reuse an existing exact decision without another modal; unapproved guest
requests receive one main-owned launch decision. Standing or interactive agent authorization
comes from the existing agent admission owner within its action and host grants, binds the same
request, and never manufactures a human gesture or grants the whole guest/action new authority.

The exact action remains finite while a native launch decision is pending. This decision uses
the originating action lifetime, with current authority throughout; ordinary guest requests and
connector deadlines do not change. After approval, the terminal owner issues one new terminal
identity and one one-use, short-lived handoff ticket. Decision and ticket expiry provide an
actionable refusal to invoke the action again.
Renderer data cannot substitute an existing terminal, another workspace, profile, command, or
configuration. Revalidate caller, activation, grants, executable, workspace, and cancellation at
each asynchronous admission boundary. Before physical dispatch, revocation prevents spawning.
If dispatch is in flight, retain the physical reservation until it settles, reject late ownership,
and describe completion as uncertain rather than proving the command never ran. After ordinary
terminal ownership is transferred, extension revocation leaves that terminal intact.

The trusted plain-shell provider composes a fixed POSIX bootstrap. Executable, arguments, and
non-secret configured environment remain structured positional data; no extension supplies
shell program text. The initial command receives its configuration once. After its exit,
including failure or a foreground INT/QUIT interruption, the bootstrap replaces itself with the host's ordinary default login shell. The bootstrap catches these signals without
ignoring them in its child; the command remains interruptible.
Protected terminal and agent environment names retain their existing main-owned authority.

Record the handed-off terminal with the immutable ordinary default-shell profile. The transient
command, arguments, and configuration never enter the recovery record or a saved profile.
ADR-006's shell recovery continues to create a fresh plain shell in the recorded folder, with no
setup replay and no claim of process continuity. Terminal output or exit zero is not readiness
proof; the consumer observes its domain's public metadata independently.

The donor's [project setup decision at the pinned commit](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-048-explicit-skillager-project-setup.md)
retains fresh-terminal setup, user control after handoff, and no recovery replay as product
constraints. Reject its obsolete built-in integration, private handoff mechanics, and persistent
custom-command-profile composition. Extension-local Skillager workflows consume this
public capability through the existing action, provider, supervisor, and ProjectHost seams.

## Consequences

Setup remains available before project readiness and can leave a failed command visible beside
an ordinary usable shell. A pending request has a finite capability lifetime; a handed-off
terminal has the existing terminal lifetime. Recovery deliberately restores shell usability
without repeating native effects. Exact command and destination binding costs a small transient
admission owner and requires real PTY lifecycle evidence.

## Rejected alternatives

- Typing input into a shell, including a newly created shell, races startup files and exposes
  unrelated input state.
- A shell-specific interactive command string changes argument semantics and expands data into
  executable syntax.
- A saved custom-command profile replays setup or misrepresents plain-shell recovery.
- Treating native connector approval as a terminal grant omits the separate interactive handoff
  and destination decision.
- Killing a terminal after ordinary ownership transfer would let extension disable interrupt
  user-controlled sessions.
- Describing a canceled in-flight spawn as no effect invents rollback evidence.
