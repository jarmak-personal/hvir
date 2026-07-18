# ADR-008: Registered projects with discovered worktree workspaces

## Context

Agent configuration and trust are repository-scoped, while active work commonly spans
several Git worktrees. hvir needs stable navigation and authority without becoming a
worktree orchestrator.

## Decision

Use a two-tier model: a host-qualified project root is the durable registration unit;
Git worktrees are discovered child workspaces. The workspace tier remains visible for a
single root. A non-Git directory is the same model with one workspace and no Git surfaces.
Workspace selection exists only in the top project/workspace tier; terminal lists contain
only terminals for the active workspace while inactive PTYs remain live and aggregate
attention upward.

The local project registry persists roots, display names, active workspace, and last
discovered records. Missing worktrees remain visible with their layout/session identity
until explicit dismissal. Git-worker authority covers only registered and discovered
roots, while general renderer filesystem authority remains confined to the active
workspace. Workspace switches preserve live PTYs and per-workspace tabs/layout. Project
close unregisters without touching repository data and requires another project to become
active; hvir does not maintain a normal zero-project workbench state.

hvir may run `git worktree prune --expire now --verbose` only after Git marks records
prunable, after project-wide confirmation, and through single-use exact-root mutation
authorization. It never creates, moves, repairs, or removes a live worktree.

First-run registration is explicit: an explicit launcher path wins, otherwise hvir
restores history or opens the native local folder picker. Open projects use one shallow
root watch plus bounded, host-qualified shallow interests for visible directories and
open files. Repository metadata is watched separately. Plain directories stop periodic
Git work after discovery; repository change snapshots are bounded and disclose truncation
rather than presenting incomplete per-path details as complete.

## Consequences

Project identity, worktree navigation, terminal ownership, attention, and recovery share
one stable hierarchy. Worktree additions appear without hvir managing their lifecycle.
Missing storage and broad directories degrade visibly without recursive background scans.
The narrow prune exception cleans Git administrative records but does not widen product
scope into repository orchestration.

## Rejected alternatives

- Flat directory registrations, a separate host strip, or collapsing the workspace tier.
- hvir-managed worktree creation/removal or automatic pruning.
- One Git worker or SSH host per workspace, or general renderer access to inactive roots.
- Killing PTYs on navigation, recursively watching projects, or one SSH watcher per tree
  row.
- Silently using `process.cwd()` on first run, forbidding non-Git roots, or returning an
  unbounded Git change model.
