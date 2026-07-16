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

**Current status:** complete. The local vertical slice is mounted and runtime-smoked: live changes
(including terminal-only `.git` updates and unborn repositories),
branch-point isolation, diff tabs, topology-safe cursor/infinite history with bounded DOM,
commit detail with historical file diffs, badge, compact lazy blame gutter, a current-branch
rail graph with expandable changed-file trees, and a dedicated all-ref topology viewer with
virtual rows and a tree-shaped commit inspector. The Files tree also marks ignored entries
through lazy per-directory Git batches without delaying filesystem paint. Git transport
calls are brokered by host ID as recorded in the ADR-005 addenda. Sustained real-SSH usage
accepted the shared UI, and hands-on graph review accepted the topology presentation; further
iteration on the large History view remains normal UX follow-up rather than a phase blocker.

**Hands-on evidence (2026-07-13):** the real-host Git panel, blame, and a 400+ commit
history loaded cleanly. Live Changes/diffs and terminal-driven refresh were subsequently
accepted through sustained remote use after the watch fix. The subsequent
all-ref graph pass on that repository exposed a self-feeding index refresh and SSH channel
exhaustion; both are fixed in the engine/transport. The exact repository was retested with no
graph flashing or channel errors. Diff tabs load, although an intermittent visual flash during
diff loading remains as a separate P1 follow-up. Remaining specialized auth/network scenarios
are recorded as accepted Phase 4 residual risk rather than blockers for the Git reading workflow.

**Scope amendment (2026-07-12):** hands-on review established that branch/merge topology
is core to the Git reading workflow. A read-only commit graph is now in scope; it does not
itself relax the Phase 5 prohibition on stage/commit/push/branch/stash operations. Phase
8 later admits one separately recorded exception: clean switching among existing local
branches from the active workspace (ADR-005 Phase 8 addendum). The graph implementation
spike and acceptance are tracked in
[`03-05-review-followups.md`](03-05-review-followups.md).

## Tasks

### Engine (extend the Phase 3 utility-process git module)
- [x] Status: parse `git status --porcelain=v2` into a changed-file model (staged /
      unstaged / untracked / conflicted).
- [x] Diff sources: name-status + per-file patches for working-tree-vs-HEAD and
      HEAD-vs-branch-point (`merge-base` with the default branch); file-at-revision
      reads.
      The MergeView path carries the two revision blobs rather than serializing a patch;
      it preserves the same diff source while keeping rendering local.
      Branch-point list counts and opened diffs both use merge-base → HEAD; uncommitted
      content is intentionally confined to working-tree/HEAD views.
- [x] History: incremental `git log` walk (paged — never walk a whole large repo up
      front), per-file history, commit detail (message, stat, patches).
- [x] Blame: `git blame --porcelain`, lazy per file.
- [x] Invalidation: refresh status/diff state on `ProjectHost.watch` events, debounced;
      never poll on a timer when watch events are available.

### UI
- [x] Git panel in the left rail (sibling of the file tree): **Changes** view first —
      changed-file list with per-file add/del counts, grouped working-tree vs
      branch-point; click opens the file in a diff-mode tab with the right base
      (ADR-007 — this wires the "opened from git context → diff mode" default).
- [x] Changed-file count badge per project/workspace (feeds Phase 7 rollups).
- [x] History view: compact graph/commit list (infinite scroll off the paged log),
      fixed-row changed-file tree expansion, and per-file historical diffs opening in tabs.
- [x] Blame layered onto source-mode tabs (gutter or hover), toggleable.
- [x] Read-only commit topology graph with branch/merge lanes, paged history, and commit
      detail/diff integration (see the active review queue).
- [x] Files-tree ignore decoration: paint lazy directory listings immediately, classify
      their basenames through bounded off-thread `git check-ignore` batches, and visibly
      distinguish direct ignored roots plus their inherited descendants.

## Acceptance criteria
- [x] In a repo where an agent has uncommitted work: Changes view shows it live,
      updating as the agent edits; one click gets a diff tab; the branch-point group
      answers "what happened on this branch."
- [x] History on a large repo (e.g. a linux/chromium-scale clone if available, else the
      largest to hand) scrolls smoothly with no renderer stall; first paint of the
      panel is instant while the log streams in.
- [x] Blame on a large file appears without blocking the tab.
- [x] All of the above works identically on an SSH-host project.
- [x] Status table updated.

## Non-goals
Except for Phase 8's narrow, clean switch among existing local branches, Git write
operations remain **out of scope for v1**: no stage, commit, push/pull, stash, merge,
rebase, or branch create/delete/rename/track controls. Submodule UI. Any further write
operation is a §2 conversation and an ADR first.
