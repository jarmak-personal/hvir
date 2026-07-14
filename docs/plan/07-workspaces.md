# Phase 7 — Workspaces

**Read first:** [`00-overview.md`](00-overview.md); design.md ADR-008 (project →
worktree tiers — implement exactly; the discovered-never-managed rule is the §2
guardrail), ADR-009/010 (rollups, hosts).

## Goal

The top of the UI layout (design.md §5): a projects bar with worktree workspaces beneath, notification and
changed-file rollups at each tier, and per-workspace layout that survives restarts.
This is where the single-directory viewer becomes the multi-agent workbench.

## Tasks

### Model (ADR-008)
- [x] Project registry (persisted): projects are *registered* — {hostId, path, display
      name}. A project may be a git repo or a plain directory (degenerate
      single-workspace project — no special cases downstream).
- [x] Worktree *discovery*: `git worktree list --porcelain` via the git module, per
      project, refreshed on watch events and on demand. **hvir never creates, moves, or
      removes worktrees** — if a task seems to need that, stop and re-read §2.
- [x] Workspace = one worktree (or the plain directory). Each workspace owns its file
      tree root, git state, open tabs, and terminals.

### UI
- [x] Top projects bar (per the §5 layout): one tab per project, host badge for non-local
      hosts, connection state (Phase 4) surfaced here.
- [x] Worktree tier inside a project: workspace switcher — **collapsed entirely when
      the project has only its main checkout** (ADR-008).
- [x] Newly discovered worktrees appear automatically (an agent tool creating a
      worktree shows up without user action); removed worktrees gray out with their
      state preserved until dismissed.
- [x] Rollups (ADR-009): terminal dots → workspace → project tab, aggregation only,
      focus-clears at the leaf. Changed-file counts (Phase 5) roll up alongside.
- [x] Per-workspace persistence: open tabs (with view modes), terminal sessions (via
      the Phase 6 session registry), pane layout — restored on relaunch per workspace.

### Glue
- [x] Terminals are workspace-scoped: new terminals cwd to the workspace root; the
      right-rail terminal list groups by workspace.
- [x] Moving between workspaces is instant (state kept warm, subject to memory sanity —
      unfocused workspaces may drop expensive state like scrollback-heavy panes, but
      never PTYs).

## Acceptance criteria

Implementation is complete; the cross-host, relaunch, and churn matrix below remains the
Phase 7 acceptance gate. Automated verification currently covers registry persistence,
NUL-safe worktree discovery, broker confinement, changed-count polling, and the full
Electron smoke (including terminal recovery/reconnect and PTY cleanup).

Same-host SSH capacity beyond one physical connection, including 10+ restored terminals
and multiplexed context telemetry, is the explicit follow-on in
[`Phase 7.5`](07.5-ssh-capacity.md); serialized exec headroom is not its final scaling
model.

- [ ] Register two projects (one local, one SSH). Create a worktree from a terminal
      (`git worktree add ...`): it appears as a workspace without user action; its
      agent terminal's dots roll up to the right project tab.
- [ ] A project with no extra worktrees shows no worktree tier.
- [ ] A plain non-git directory works as a project (tree + tabs + terminals; git panel
      absent).
- [ ] Quit and relaunch with 2 projects × several workspaces: tabs, layouts, and
      (via resume) agent sessions come back per workspace.
- [ ] With 5+ workspaces active and churning, the UI stays instant (§3.2 — this is the
      load VSCode strains under; it's the reason hvir exists).
- [ ] Status table updated.

## Non-goals
Worktree lifecycle management (create/delete/merge — orchestration creep, rejected in
ADR-008). Cross-workspace search. Session-queue/kanban features of the harness-first
tools — that's their lane.
