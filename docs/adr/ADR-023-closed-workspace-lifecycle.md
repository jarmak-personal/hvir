# ADR-023: Closed workspaces unload and resurface on bounded Git activity

> Lifecycle: Partially superseded
> Supersedes: [ADR-008](ADR-008-project-worktree-workspaces.md) | partial | Every present discovered worktree remaining open and visible.
> Superseded by: [ADR-027](ADR-027-demand-driven-workspace-activity.md) | partial | Fixed per-worktree periodic status cadence.

## Context

ADR-008 made every discovered Git worktree a visible workspace and preserved inactive
workspace terminals, tabs, and layout. Issue-driven workflows can retain many valid worktrees
after the user no longer needs to watch them. Removing a worktree tab previously required Git
to report that worktree missing.

A present worktree needs a durable closed state that does not manage the Git worktree and does
not retain hidden runtime resources. The user also needs a predictable way to notice later work
without adding recursive watches, one watcher per worktree, or remote helpers.

## Decision

A registered project's discovered-worktree catalog owns whether each present worktree is open or
closed. The active workspace cannot close. A confirmed close leaves the Git worktree unchanged,
preserves valid viewer and layout persistence, and removes the workspace from normal navigation.
The catalog provides the explicit path to reopen and activate a present closed worktree.

A closed workspace owns no renderer workspace runtime, PTY, hvir terminal recovery record,
attention state, web pane, preview authority, or workspace-scoped resource lease. When live or
retained terminals exist, hvir names their exact count and requires destructive confirmation.
Confirmed workspace close is explicit terminal close under ADR-006. hvir forgets only its own
terminal records; provider-owned conversations and artifacts remain outside this lifecycle.

The existing batched project refresh samples closed present worktrees through the existing
per-worktree porcelain status invocation. The Git worker returns a fixed-schema SHA-256 digest of
at most 2,000 porcelain-v2 path and state entries plus the entry count and truncation state. Main
combines that result with the host-qualified root, HEAD, and branch from discovery. It stores no
path list, diff, file content, terminal content, timestamp, or file size.

Two activity snapshots are comparable only when their host-qualified root, fields, schema, bound,
and untruncated state match. A comparable change to HEAD, branch, entry count, or digest reopens
the tab without activating it. A closed missing worktree also reopens when successful discovery
reports it present again. The first comparable snapshot establishes a missing baseline without
reopening. Failed, stale, disconnected, truncated, and non-comparable results do not replace a
valid baseline or reopen a workspace.

This record supersedes ADR-008 only where that record requires every present discovered worktree
to remain an open workspace and every inactive workspace to retain live runtime. It extends
ADR-006 by treating confirmed workspace close as explicit close for the workspace's hvir terminal
records. ADR-010, ADR-013, ADR-014, and ADR-020 retain their host, authority, cleanup, web-pane,
and provider-ownership decisions.

## Consequences

The workspace bar can remain focused while the project catalog preserves bounded worktree
identity. Closed worktrees consume periodic Git status work at the existing cadence but retain no
workspace runtime. Porcelain-state comparison intentionally misses repeated content-only writes
that leave HEAD, branch, paths, and states unchanged; manual reopen remains the fallback.

Close requires coordinated revocation across the registry, renderer resources, terminals,
recovery metadata, attention, and web panes. Reopen restores persisted viewer and layout state but
cannot restore revoked web guests or forgotten terminal rows. Local and SSH projects share the
same host-qualified policy without new transport or watcher ownership.

## Rejected alternatives

- Preserve hidden live terminals and recovery state, because closed workspaces would become an
  unbounded hidden session owner.
- Permit closing the active workspace and select a neighbor automatically, because close should
  not change workspace focus implicitly.
- Track file modification times or sizes, because the bounded porcelain state plus manual catalog
  is sufficient for the accepted first version.
- Add recursive filesystem scans, one watcher per worktree, or remote helpers, because those widen
  resource and transport ownership for a navigation feature.
- Close or prune worktrees from pull-request lifecycle events, because that is a separate product
  decision and would make hvir manage worktree lifecycle.
