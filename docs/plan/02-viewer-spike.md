# Phase 2 — Viewer spike (the risk)

**Read first:** [`00-overview.md`](00-overview.md); design.md §6 (the terminal risk —
this phase exists to retire it), ADR-003 (swappable terminal), ADR-004 (CodeMirror 6 +
Shiki), §3.2 (nothing blocks the paint).

## Goal

The design doc's spike acceptance test: **one ghostty-web terminal pane that feels good
and renders fast**, next to one file tree and one CodeMirror/Shiki viewer, with the UI
never stalling. If this passes, everything after is assembly of known parts. This phase
ends with an explicit go/no-go decision recorded in design.md.

## Tasks

### Terminal pane (the actual risk)
- [ ] **Verify the ghostty-web landscape first**: current package name, maintenance
      status, and how close its API is to xterm.js. Also check `electron-libghostty`
      maturity on Linux. Record findings in this doc before choosing.
- [ ] Implement `TerminalPane` (Phase 1 interface) on the chosen engine. If ghostty-web
      is unusable, fall back to `@xterm/xterm` — that is an allowed spike outcome, not a
      failure (ADR-003 exists precisely for this).
- [ ] Wire pane ↔ PTY supervisor: spawn a `plainShell` PTY on `LocalHost`, stream
      data both ways, handle resize.
- [ ] Surface OSC 0/2 title events and BEL/OSC 9 through `TerminalPane` callbacks (just
      log them for now — consumed in Phase 6).

### File tree
- [ ] Read-only file tree over `ProjectHost.readdir`/`stat`, lazy-loading directories.
      One hardcoded-or-CLI-arg root directory is fine for the spike.
- [ ] Tree updates on `ProjectHost.watch` events, with the watcher running off the
      render thread.

### Viewer
- [ ] Read-only CodeMirror 6 pane; clicking a tree file opens it (single pane, no tabs).
- [ ] Shiki highlighting running **off the render thread** (utility process or web
      worker), tokens streamed to the viewer. Verify current Shiki API for
      worker-friendly usage.
- [ ] Large-file guard: files past a size threshold open without highlighting rather
      than stalling anything.

### Spike evaluation
- [ ] Measure and record in this doc: terminal input latency (feel test vs a native
      terminal), sustained-output rendering (e.g. `yes` / large build log), open a
      ~5 MB file, interact with the terminal while the tree watches a churning repo.
- [ ] **Go/no-go**: record the engine decision and evidence as an addendum to ADR-003
      in design.md (resolves the "native libghostty vs ghostty-web" open question, §9).

## Acceptance criteria
- [ ] Terminal passes the feel test: typing latency indistinguishable from a native
      terminal in normal use; no dropped rendering during sustained output.
- [ ] Renderer never blocks: UI interactions stay instant during large-file open,
      heavy terminal output, and watcher churn — all three at once.
- [ ] Tree, viewer, and terminal all speak only to `ProjectHost` / PTY supervisor /
      `TerminalPane` — verified by the Phase 1 lint rules still passing.
- [ ] ADR-003 addendum committed; status table updated.

## Non-goals
Tabs, view modes, editing, markdown rendering (Phase 3). Multiple terminals, titles UI,
notifications (Phase 6). Aesthetics beyond "not embarrassing" — polish is Phase 8.
