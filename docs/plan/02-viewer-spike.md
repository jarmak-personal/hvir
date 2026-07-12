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
- [x] **Verify the ghostty-web landscape first**: current package name, maintenance
      status, and how close its API is to xterm.js. Also check `electron-libghostty`
      maturity on Linux. Record findings in this doc before choosing.
      → Verified 2026-07-12 from the live npm registry and upstream repositories:
      the maintained package is `ghostty-web` (Coder, v0.4.0, published 2026-06-28;
      active `next` builds and demo releases). Its public surface deliberately mirrors
      xterm.js: `Terminal`, `open`, `write`, `resize`, `focus`, `onData`, `onResize`,
      `onBell`, `onTitleChange`, and `FitAddon`; initialization adds one async `init()`
      call for the ~423 KB Ghostty VT WASM. It does not expose xterm's parser hook, so
      the pane adapter must parse otherwise-unexposed OSC events at its boundary.
      `electron-libghostty@0.0.0`, by contrast, is an unpublished implementation in
      practical terms: its npm tarball is a 105-byte `package.json` with no code,
      repository, API, or Linux artifact. Upstream `libghostty` is now usable on Linux,
      but its unversioned C API and native renderer integration remain a much larger
      Electron integration than this spike. **Choice:** use `ghostty-web` for the spike;
      keep `@xterm/xterm` as the interface-compatible fallback if feel/performance fails.
- [x] Implement `TerminalPane` (Phase 1 interface) on the chosen engine. If ghostty-web
      is unusable, fall back to `@xterm/xterm` — that is an allowed spike outcome, not a
      failure (ADR-003 exists precisely for this).
      → `GhosttyTerminalPane` owns the WASM-backed canvas, fit/resize lifecycle, and
      engine subscriptions behind the Phase 1 interface.
- [x] Wire pane ↔ PTY supervisor: spawn a `plainShell` PTY on `LocalHost`, stream
      data both ways, handle resize.
      → Typed IPC keeps input fire-and-forget; output is coalesced during sustained
      bursts while the first chunk remains immediate for typing latency.
- [x] Surface OSC 0/2 title events and BEL/OSC 9 through `TerminalPane` callbacks (just
      log them for now — consumed in Phase 6).
      → Title/BEL use the engine events; a bounded streaming OSC adapter covers OSC 9
      and the general callback missing from ghostty-web's public parser surface.

### File tree
- [x] Read-only file tree over `ProjectHost.readdir`/`stat`, lazy-loading directories.
      One hardcoded-or-CLI-arg root directory is fine for the spike.
      → Root defaults to cwd and accepts `--project-root=…`; IPC paths are normalized,
      host-checked, and confined to that root at runtime.
- [x] Tree updates on `ProjectHost.watch` events, with the watcher running off the
      render thread.
      → `LocalHost`/chokidar remains main-side and invalidations are throttled before
      crossing into the renderer so churn cannot schedule a paint per filesystem event.

### Viewer
- [x] Read-only CodeMirror 6 pane; clicking a tree file opens it (single pane, no tabs).
- [x] Shiki highlighting running **off the render thread** (utility process or web
      worker), tokens streamed to the viewer. Verify current Shiki API for
      worker-friendly usage.
      → Verified Shiki 4.3.1's current guidance and used a persistent web worker with
      `createHighlighterCore`, fine-grained language/theme imports, the JavaScript regex
      engine, and 200-line decoration batches streamed back to CodeMirror.
- [x] Large-file guard: files past a size threshold open without highlighting rather
      than stalling anything.
      → Files over 1 MiB bypass the highlighter; binary and >64 MiB files are guarded.

### Layout controls
- [x] Draggable dividers for the existing pane boundaries: resize the left file-tree
      width and the viewer/terminal height, with sensible minimums, keyboard nudging,
      and double-click reset. Keep sizes in memory for the spike; Phase 7 persists pane
      layout per workspace, while Phase 8 owns creating multiple viewer/terminal splits.
      → Pointer-captured dividers update CSS grid tracks without re-rendering pane
      contents on every pixel. Arrow keys nudge by 16 px; drag sizes are clamped; reset
      restores responsive defaults. The Electron smoke verifies both boundaries move.

### Spike evaluation

**Exploratory macOS pass (2026-07-12, MacBook Air):** terminal typing latency felt
good in normal Codex use; repeated file switching and fresh opens did not reproduce one
earlier JSON-open hitch (the machine was mildly low on battery when it occurred).
Divider dragging stayed responsive and the Codex TUI resized, but once its input row
disappeared visually after a resize while remaining interactive; pressing Enter caused
it to redraw. Keep this as an unresolved Ghostty/PTY/TUI resize observation and try to
reproduce it with Codex plus another full-screen TUI. A Codex-created directory and ten
new files appeared in the tree immediately with no visible watcher hitch. Dark-theme
visual tuning was noted and intentionally deferred to Phase 8 polish.

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
- [x] Tree, viewer, and terminal all speak only to `ProjectHost` / PTY supervisor /
      `TerminalPane` — verified by the Phase 1 lint rules still passing.
- [ ] ADR-003 addendum committed; status table updated.

## Non-goals
Tabs, view modes, editing, markdown rendering (Phase 3). Multiple terminals, titles UI,
notifications (Phase 6). Aesthetics beyond "not embarrassing" — polish is Phase 8.
