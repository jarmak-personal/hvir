# ADR-024: Demand-driven terminal workspace lifecycle

## Context

Registered projects and discovered worktrees are navigation and authority records, but the
renderer has also used a mounted terminal workspace component as the owner of session state,
recovery effects, attention, and presentation. That coupling lets catalog growth allocate
terminal work and makes an unrelated project or watch refresh fan out across every discovered
worktree.

The existing decisions intentionally preserve live PTYs during workspace navigation, define
Bare Shell as the default launch choice, and retain exact provider-owned recovery metadata.
Those rules do not require every registered worktree to own renderer terminal state, every
materialized workspace to contain a session, or every session to have a live PTY. Treating those
states as equivalent wastes resources and risks turning presentation teardown into session
teardown.

## Decision

Terminal workspace runtime is demand-driven. Registered does not mean materialized;
materialized does not mean a terminal exists; a terminal session existing does not mean its PTY
is live; and a live terminal does not need to be visible or focused.

Use the following lifecycle language in product and architecture discussions:

- A **registered worktree** is host-qualified catalog metadata. Registration and discovery alone
  allocate no renderer terminal workspace, session, pane, provider probe, recurring terminal
  effect, or PTY.
- A **materialized workspace** has renderer-side terminal ownership and UI state because an
  explicit event requires it. It may contain no terminal sessions.
- A **retained session** is a main-owned, host-qualified recovery record with no allocated PTY.
  Retention alone does not require renderer workspace materialization.
- A **starting session** is an explicit fresh launch in progress. A **resuming session** is an
  exact provider-owned recovery attempt in progress; resume never degrades into an implicit fresh
  launch.
- A **live session** owns a PTY through the supervisor. A **stopped session** remains represented
  without a live PTY and carries an explicit reason such as exit, launch failure, transport loss,
  or recovery unavailability.
- A **visible terminal** has a presentation surface currently shown. A **hidden terminal** retains
  its session, and possibly its live PTY, without a shown surface. A **focused terminal** is the
  visible terminal currently receiving input.
- **Close** is a transition, not a persistent terminal state. It terminates resources owned by
  the session, applies the governing recovery-record policy, and removes the session.

Workspace selection materializes the selected workspace so it can present an empty terminal area
and explicit launch controls. An explicit fresh launch or split, an accepted exact-recovery
decision, or a terminal transfer materializes its exact target when needed. Automatic recovery
may materialize only the workspaces and retained sessions admitted by its existing policy.
Catalog discovery, watch refresh, provider availability, and the mere presence of retained
records do not materialize every workspace.

A selected empty workspace remains materialized while it is presented. An unselected workspace
may dematerialize only when it owns no renderer session, live or in-flight terminal resource,
presentation, transfer, subscription, timer, or other terminal effect. Revocation rejects late
asynchronous completion. Main-owned retained recovery records may outlive renderer
dematerialization and are reconsidered only through the recovery policy. A materialized owner
with live inactive sessions survives workspace navigation independently of its React
presentation subtree; navigation never stops its PTYs.

Bare Shell remains the immutable default choice for an explicit new-terminal or split action.
Opening an empty workspace does not start it. Exact recovery retains the provider, profile,
host-qualified identity, and fail-closed rules from the provider and recovery decisions.
Recovery skip, a missing resume artifact, host disconnect, process exit, explicit close, and
workspace dematerialization remain distinct transitions or outcomes; none is an implicit fresh
launch or a synonym for another.

Attention, harness identity, host and transport availability, recovery disposition, session
liveness, presentation, workspace selection, and terminal focus are independent qualifiers.
Unqualified **active** is avoided when one of those terms expresses the actual state. This is a
behavior and ownership vocabulary, not a requirement for one global store or terminal-state
enum.

## Consequences

Catalog size no longer implies terminal runtime size. Empty workspaces can support code and Git
review without starting a process, while users can keep any number of intentionally live
background terminals subject only to their machine's real capacity. Renderer owners must model
materialization and resource revocation explicitly, and terminal state needed while hidden can no
longer live only in a selected React subtree.

Recovery metadata remains main-owned and host-qualified; PTYs remain supervisor-owned;
presentation remains behind `TerminalPane`; providers retain harness semantics; and local and SSH
projects follow the same lifecycle through `ProjectHost`. File, repository, and watch correctness
is unaffected by whether terminal runtime is materialized.

## Rejected alternatives

- Mount one terminal workspace for every registered worktree and contain only the resulting
  development measurements; that leaves the production render and resource fanout intact.
- Start Bare Shell automatically for an empty workspace; a default choice is not user intent to
  allocate a process.
- Unmount or stop live terminals on workspace navigation; that violates the retained inactive-PTY
  contract and discards user-owned work.
- Impose a universal worktree or live-terminal cap, or silently suspend or evict sessions; machine
  capacity is not a truthful product lifecycle.
- Collapse registration, materialization, recovery, liveness, presentation, attention, and focus
  into one enum or global renderer store; they have different owners and independent transitions.
