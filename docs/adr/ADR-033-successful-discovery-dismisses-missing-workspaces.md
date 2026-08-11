# ADR-033: Successful discovery dismisses missing workspaces

## Context

ADR-008 retained missing worktrees until explicit dismissal so their workspace and session
identity stayed visible. Agent workflows now create and remove enough short-lived worktrees that
those records grow without bound, even though a successful Git discovery can identify that the
checkout is definitively gone.

Catalog cleanup must not turn hvir into a worktree orchestrator, mistake an unavailable host or
failed discovery for removal, or leave terminal recovery, renderer resources, or web panes owned
by a workspace that no longer exists. Local and SSH projects need one host-qualified rule.

## Decision

Every current, successful Git worktree discovery is authoritative for catalog presence. A known
workspace is definitively missing when Git either reports its administrative record as prunable
or omits the workspace from that successful result. hvir automatically dismisses every such
workspace from the registered project's catalog. A failed discovery, disconnected host, or stale
refresh generation never triggers removal.

One main-owned workspace-removal coordinator owns the lifecycle for discovery, manual dismissal,
and the existing prune workflow. It first forgets hvir's retained terminal sessions for the exact
host-qualified workspace, then dismisses the catalog record, then revokes workspace-scoped
resources and closes its web panes. A retained or live session does not block this lifecycle;
provider-owned conversations and artifacts remain outside hvir's catalog authority.

Automatic dismissal does not delete a checkout, run `git worktree prune`, or otherwise mutate the
repository. The existing explicit prune operation remains the only hvir path that removes stale
Git administrative records.

This supersedes ADR-008 only where that record retains missing worktrees until explicit
dismissal. ADR-023 continues to govern closed workspaces whose worktrees remain present, and
ADR-006, ADR-010, ADR-013, ADR-014, ADR-024, and ADR-027 retain their resource, host, web-pane,
ownership, terminal, and refresh-generation decisions.

## Consequences

Successful rediscovery bounds the workspace catalog without a per-workspace action, including
registries that accumulated missing entries under the earlier rule. Resource cleanup has one
ordering and implementation across automatic discovery, manual dismissal, and explicit prune.
Active-workspace removal selects the registry's normal present fallback and replaces its watch.

A prunable Git administrative record may be reported again by later discovery until the user
explicitly prunes it, but it does not become durable hvir workspace state. Discovery failure and
host unavailability preserve the last known catalog because absence has not been established.

## Rejected alternatives

- Retain missing or prunable workspaces until individual dismissal or prune, because transient
  agent worktrees make that catalog ownership unbounded.
- Require several consecutive omissions, because that adds hidden counters and delay after Git
  has already supplied a successful authoritative result.
- Let retained or live sessions block removal, because a checkout that no longer exists cannot
  remain a valid workspace owner and the established cleanup lifecycle already releases its hvir
  resources.
- Automatically run `git worktree prune`, because catalog hygiene does not authorize a repository
  mutation or widen hvir into worktree orchestration.
