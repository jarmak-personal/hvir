# Phase 8 — Polish & packaging

**Read first:** [`00-overview.md`](00-overview.md); design.md §3 (principles — polish
means responsiveness and rendering quality, not feature additions), ADR-003 (terminal
focus and file-link seam), ADR-005 (bounded branch navigation), ADR-007 (view-mode
philosophy extends to any new renderers), ADR-008 (one workspace selector), and ADR-009
(notification semantics and visual language).

## Goal

Turn "works" into "gorgeous and shippable": themes, side-by-side panes, renderer
completeness, a small bounded branch-navigation control, clearer terminal/notification
information architecture, a one-click terminal-focus mode, a performance pass against
the load-bearing scenarios, and installable builds for Linux and macOS.

## Tasks

### Rendering & themes
- [x] Theme system: light/dark app themes with Shiki themes kept in sync (one theme
      choice drives chrome, viewer, and rendered markdown consistently). Ship a small
      curated set, not a theme engine.
- [x] Terminal colors follow the app theme by default, overridable.
- [x] Renderer completeness pass: images open as a proper image view; binary files get
      a sane fallback instead of garbage; CSV renders as a table (rendered mode);
      notebook/other formats — only if trivial, else parking lot.
- [x] Typography/spacing pass on rendered markdown — this is a "renders beautifully"
      surface; treat readability as the feature.

### Layout
- [x] Side-by-side panes: split the viewer area (like VSCode), tabs draggable between
      panes; terminal area supports splits too (per the §5 layout).
- [x] Add a compact double-up-chevron control to the horizontal divider that expands the
      active terminal deck to the full center height. In focus mode it becomes a
      double-down-chevron and restores the exact pre-expansion divider height.
- [x] Keep terminal focus transient: hide rather than unmount the viewer, keep PTYs and
      tabs alive, do not overwrite the persisted per-workspace terminal height, and do
      not reopen maximized after relaunch.
- [x] Restore the viewer automatically before every file activation from Files, Git
      Changes/History/graph, rendered internal links, or a terminal path link. Activating
      an already-open tab follows the same rule.
- [x] Extend `TerminalPane` with an engine-agnostic user-activated link event. Resolve
      OSC 8 file targets and supported plain `path:line[:column]` links relative to the
      host-qualified active workspace; reject paths outside it and never execute text.
- [x] Keep workspace selection in one place: remove inactive-worktree jump rows from the
      right terminal rail. It lists only terminals owned by the active workspace; inactive
      terminal attention continues to roll up to the top workspace/project controls.
- [x] Keybinding surface: the handful of core actions (cycle view mode, focus terminal
      / viewer / tree, toggle terminal focus, workspace switch) documented and rebindable
      via a simple JSON config. No keymap engine.
- [x] Minimal settings UI (or settings file + reload): theme, idle threshold,
      resume-on-start behavior, keybindings pointer.

### Git branch navigation
- [x] Add an off-thread, host-agnostic branch model for the active workspace: current or
      detached HEAD, existing local branches, and the worktree path occupying each branch.
- [x] Add a compact branch selector to the Git rail. Enable switching only when the Git
      worktree is clean, no hvir viewer tab in that workspace has unsaved content, and the
      target is not checked out in another worktree. Explain disabled targets calmly.
- [x] Execute only an exact existing-branch `git switch` through a single-use main-process
      broker authorization. Never force, discard, autostash, create, delete, rename, or
      track a branch; advanced cases stay in the terminal.
- [x] After a successful local or SSH switch, refresh worktree labels, Files, Changes,
      History/graph, changed counts, and clean tabs without blocking paint or losing PTYs.

### Notifications and status clarity
- [x] Give connection state, Git changed counts, and terminal attention distinct visual
      treatments. Remove the same-looking leading/trailing dots; use one consistent,
      accessible trailing attention badge with unseen-terminal counts on workspace and
      project parents.
- [x] Functionally audit attention end to end: plain BEL and supported OSC bell events,
      new output, idle-after-burst, terminal focus clearing, parent aggregation, workspace
      switching, window focus, and the quiet OS badge. Add deterministic regressions for
      every broken path found before styling it.

### Performance & robustness pass
- [x] Profile the §3.2 gauntlet and fix regressions: 5+ churning workspaces, sustained
      terminal output, large-file open, git status storms. Add a repeatable script or
      documented manual protocol for this gauntlet so later changes can re-run it.
- [ ] Repeat the Phase 7 workspace edge matrix while polishing: terminal-created
      worktree auto-discovery and rollups, collapsed single-workspace tier, plain non-git
      project behavior, and cancel/confirm stale-record pruning on local and SSH hosts.
- [ ] Repeat the Phase 7.5 real-host topology with 12+ terminals across two SSH projects
      and three workspaces, then audit the remote host after quit for leftover
      `hvir-telemetry.*` directories or follower `tail` processes.
- [ ] Memory sanity: long-running session (hours, many terminals) has bounded growth;
      scrollback limits enforced.
- [x] Error surfaces: host disconnects, git failures, and renderer errors all land as
      visible-but-calm UI states, never silent failure or a white screen.

### Packaging
- [x] electron-builder (or forge — verify current best practice with electron-vite):
      Linux AppImage + deb, macOS dmg/zip. CI workflow building all targets on tag.
- [x] App icon, name, basic README with screenshots.
- [x] macOS signing/notarization: investigate and document; unsigned dev builds are
      acceptable for v1 if cost is prohibitive — record the decision.

## Acceptance criteria
- [ ] Fresh install from a built artifact on Linux and macOS runs the full workflow
      (register projects, view, terminals, SSH) with no dev environment.
- [x] Theme switch is instant and consistent across chrome, code, markdown, terminal.
- [ ] On local and SSH repositories, the Git rail accurately shows the active branch and
      switches to an existing unoccupied branch only when both Git and hvir are clean;
      dirty, occupied, detached, and failed cases are safe and legible.
- [x] The terminal rail contains no duplicate workspace navigation, and connection,
      changes, output, bell, and idle attention are distinguishable without relying on
      color or ambiguous dots.
- [x] Terminal focus expands and restores without losing viewer/PTY state or changing the
      saved divider height. Every supported file activation—including a safe local or SSH
      terminal path link—restores the viewer and opens the intended workspace file.
- [x] The performance gauntlet passes on a modest machine and is documented/scripted
      for reuse.
- [ ] A reviewer who reads design.md §1 can look at the running app and agree the
      thesis shipped: view-first, agent-aware, instant.
- [ ] Status table updated; v2 parking lot (harness telemetry viewer) re-confirmed as
      parked in design.md §9/§8.

## Non-goals
The v2 harness viewer. Extension/plugin anything. Windows builds (only if incidental —
do not spend time on Windows-specific bugs). Any Git mutation beyond the bounded existing-
branch switch in ADR-005. New features not in design.md — if v1 feels incomplete, the fix
is an ADR conversation, not a quiet addition here.

## Automated implementation evidence (2026-07-15)

- `npm run gauntlet` passed seam enforcement, scoped lint, both TypeScript builds, 39 test
  files / 272 tests, the production workflow smoke, and the 30-second capacity smoke.
- The capacity run mounted 12 live terminals and measured **17.7 ms p99 / 17.8 ms max**
  responsiveness across 75 transitions. Working-set growth was 50 MiB net / 106 MiB peak,
  then all 12 terminals recovered with Changes and History ready.
- A Linux x64 `.deb` was extracted in a clean container and its packaged app passed the
  full smoke workflow; the app and `node-pty` binaries were verified x86-64. A macOS arm64
  app launched directly from the mounted DMG and passed the same workflow; both binaries
  were verified arm64. The AppImage and zip were also produced.
- The local post-gauntlet teardown audit found no telemetry helper directories, follower
  `tail` processes, PTYs, Electron app processes, Docker containers, or build volumes.

## Manual release acceptance remaining

The unchecked items are deliberately not inferred from automation: repeat the workspace
edge matrix on current local and SSH builds; run the 12+ terminal real-host SSH topology
and teardown audit; complete the two-hour memory soak; exercise branch switching and a
fresh installed artifact against a real SSH project; and obtain the final view-first
thesis review. Phase 8 stays **in progress** until those checks are recorded.
