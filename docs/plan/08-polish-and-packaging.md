# Phase 8 — Polish & packaging

**Read first:** [`00-overview.md`](00-overview.md); design.md §3 (principles — polish
means responsiveness and rendering quality, not feature additions), ADR-007 (view-mode
philosophy extends to any new renderers).

## Goal

Turn "works" into "gorgeous and shippable": themes, side-by-side panes, renderer
completeness, a performance pass against the load-bearing scenarios, and installable
builds for Linux and macOS.

## Tasks

### Rendering & themes
- [ ] Theme system: light/dark app themes with Shiki themes kept in sync (one theme
      choice drives chrome, viewer, and rendered markdown consistently). Ship a small
      curated set, not a theme engine.
- [ ] Terminal colors follow the app theme by default, overridable.
- [ ] Renderer completeness pass: images open as a proper image view; binary files get
      a sane fallback instead of garbage; CSV renders as a table (rendered mode);
      notebook/other formats — only if trivial, else parking lot.
- [ ] Typography/spacing pass on rendered markdown — this is a "renders beautifully"
      surface; treat readability as the feature.

### Layout
- [ ] Side-by-side panes: split the viewer area (like VSCode), tabs draggable between
      panes; terminal area supports splits too (per the §5 layout).
- [ ] Keybinding surface: the handful of core actions (cycle view mode, focus terminal
      / viewer / tree, workspace switch) documented and rebindable via a simple JSON
      config. No keymap engine.
- [ ] Minimal settings UI (or settings file + reload): theme, idle threshold,
      resume-on-start behavior, keybindings pointer.

### Performance & robustness pass
- [ ] Profile the §3.2 gauntlet and fix regressions: 5+ churning workspaces, sustained
      terminal output, large-file open, git status storms. Add a repeatable script or
      documented manual protocol for this gauntlet so later changes can re-run it.
- [ ] Memory sanity: long-running session (hours, many terminals) has bounded growth;
      scrollback limits enforced.
- [ ] Error surfaces: host disconnects, git failures, and renderer errors all land as
      visible-but-calm UI states, never silent failure or a white screen.

### Packaging
- [ ] electron-builder (or forge — verify current best practice with electron-vite):
      Linux AppImage + deb, macOS dmg/zip. CI workflow building all targets on tag.
- [ ] App icon, name, basic README with screenshots.
- [ ] macOS signing/notarization: investigate and document; unsigned dev builds are
      acceptable for v1 if cost is prohibitive — record the decision.

## Acceptance criteria
- [ ] Fresh install from a built artifact on Linux and macOS runs the full workflow
      (register projects, view, terminals, SSH) with no dev environment.
- [ ] Theme switch is instant and consistent across chrome, code, markdown, terminal.
- [ ] The performance gauntlet passes on a modest machine and is documented/scripted
      for reuse.
- [ ] A reviewer who reads design.md §1 can look at the running app and agree the
      thesis shipped: view-first, agent-aware, instant.
- [ ] Status table updated; v2 parking lot (harness telemetry viewer) re-confirmed as
      parked in design.md §9/§8.

## Non-goals
The v2 harness viewer. Extension/plugin anything. Windows builds (only if incidental —
do not spend time on Windows-specific bugs). New features not in design.md — if v1
feels incomplete, the fix is an ADR conversation, not a quiet addition here.
