# Phase 5 — Git explorer

**Read first:** [`00-overview.md`](00-overview.md); design.md ADR-005 (system git),
§7 ("the what-did-the-agent-change view" — the priority order in this phase follows it),
ADR-007 (diff view mode, base selector).

## Goal

The git side of the left rail. Priority is explicitly inverted from a normal git client:
**working-tree and branch-point diffs first** — "what did the agent change since I last
looked" — then history and blame as table stakes. Everything runs off-thread through the
Phase 3 git module (system git via `ProjectHost.exec`, so it works on SSH hosts for
free).

## Tasks

### Engine (extend the Phase 3 utility-process git module)
- [ ] Status: parse `git status --porcelain=v2` into a changed-file model (staged /
      unstaged / untracked / conflicted).
- [ ] Diff sources: name-status + per-file patches for working-tree-vs-HEAD and
      HEAD-vs-branch-point (`merge-base` with the default branch); file-at-revision
      reads.
- [ ] History: incremental `git log` walk (paged — never walk a whole large repo up
      front), per-file history, commit detail (message, stat, patches).
- [ ] Blame: `git blame --porcelain`, lazy per file.
- [ ] Invalidation: refresh status/diff state on `ProjectHost.watch` events, debounced;
      never poll on a timer when watch events are available.

### UI
- [ ] Git panel in the left rail (sibling of the file tree): **Changes** view first —
      changed-file list with per-file add/del counts, grouped working-tree vs
      branch-point; click opens the file in a diff-mode tab with the right base
      (ADR-007 — this wires the "opened from git context → diff mode" default).
- [ ] Changed-file count badge per project/workspace (feeds Phase 7 rollups).
- [ ] History view: commit list (infinite scroll off the paged log), commit detail with
      per-file diffs opening in tabs.
- [ ] Blame layered onto source-mode tabs (gutter or hover), toggleable.

## Acceptance criteria
- [ ] In a repo where an agent has uncommitted work: Changes view shows it live,
      updating as the agent edits; one click gets a diff tab; the branch-point group
      answers "what happened on this branch."
- [ ] History on a large repo (e.g. a linux/chromium-scale clone if available, else the
      largest to hand) scrolls smoothly with no renderer stall; first paint of the
      panel is instant while the log streams in.
- [ ] Blame on a large file appears without blocking the tab.
- [ ] All of the above works identically on an SSH-host project.
- [ ] Status table updated.

## Non-goals
Any write operations — stage, commit, push, branch, stash are **out of scope for v1**
(view-first; the terminal is right there). Graph/topology visualization. Submodule
UI. If write operations ever come, that's a §2 conversation and an ADR first.
