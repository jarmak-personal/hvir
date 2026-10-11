# ADR-070: Explicit local workspace program connection

> Lifecycle: Active
> Supersedes: [ADR-065](ADR-065-passive-extension-program-connection.md) | partial | Application-only restriction on setup hints and ordinary-human connection requests.
> Supersedes: [ADR-051](ADR-051-approved-finite-connector-execution.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for explicit ordinary-human local-workspace connections only.

## Context

A project view can need an installed local program before showing useful observations.
Requiring its user to leave that view and enter an executable path and configuration in
Settings repeats setup work already handled by passive discovery and trusted consent.
Application and workspace connectors nevertheless retain independent native approvals.

## Decision

Workspace connectors may declare the same bounded executable-basename setup hint as
application connectors. Only an explicit connection request from a current visible,
foreground ordinary human view can use a workspace hint. Main pins the view's admitted
registered local workspace and exact host-qualified root; the guest supplies only its
declared connector identity, never a host, project or replacement root. The existing
context owner supplies a setup-only pin of main's active project/workspace selection and
owning registration identity/root; ordinary admitted view contexts remain independent.
Its existing observation includes selection and registration changes. A setup-only raw
project observation withdraws a pending connection immediately on mismatch, even when
selection returns before the ordinary coalesced metadata publication. The existing finite
connection lifetime owns and disposes that subscription; withdrawal is permanent for the
request. The context and guest owners revalidate registration, root, renderer, placement,
activation and request authority through discovery, selection, consent and persistence.
Project or worktree switching, withdrawal, cancellation and revocation end the request;
late effects cannot create authority.

Reuse passive metadata discovery, canonical executable preparation, empty argument and
environment defaults, native picker fallback and the existing trusted connection decision.
Unchanged valid approval of that exact connector on the local host needs no new decision.
Approval remains installation-, declaration-, program-, configuration- and host-scoped,
as in ADR-051; it is not a folder grant or native confinement. Every subsequent command
still pins its own admitted workspace root. Approval of another connector grants nothing
to this connector, even when both select the same program.

Installation-time connection considers application hints only. No installation operation
connects a workspace, mutates a project, discovers SSH tools or authenticates a remote host.
An explicit workspace request requires the admitted local host and never substitutes a
local program for an SSH project. Existing explicit SSH and manual advanced Settings
configuration remain available. Settings exposes passive Connect only where it has the
required application context; a workspace view supplies its own admitted target.

All unaffected ADR-065 discovery completeness, chooser-return presentation readiness,
origin denial, sixty-second lifetime and physical ownership rules remain authoritative.
ADR-051 continues to own native trust, finite execution, output and uncertain interruption.
File reading, agent access, delivery and package installation remain independent. This
adds no grant store, installer, generic setup engine or tool-domain behavior to core.

## Consequences

A local project view can propose its missing connection without path or JSON entry.
The displayed decision describes the actual program, host and native approval scope.
Remote projects continue to require their existing explicit host setup. A committed save
may outlive lost result delivery; current approval observation remains authoritative and
interruption never promises rollback.

## Rejected alternatives

- Inheriting another connector's approval would bypass its declaration and explicit consent.
- Accepting a guest-selected host or root would replace main's admitted project authority.
- Automatic workspace setup during Add would turn installation into project authority.
- Per-folder native grants would imply confinement that the host process cannot provide.
- Tool-specific setup in core would duplicate package and external-tool responsibilities.
