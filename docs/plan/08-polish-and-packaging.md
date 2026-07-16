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
      ragged CSV rows remain visible and row/column caps are disclosed; notebook/other
      formats — only if trivial, else parking lot.
- [x] Typography/spacing pass on rendered markdown — this is a "renders beautifully"
      surface; treat readability as the feature.
- [x] Keep side-by-side CodeMirror diffs vertically scrollable for long files. Preserve
      the top visible current-file line in both directions when switching between Source
      and Diff, even though the modes have different line heights and collapsed regions.

### Layout
- [x] Side-by-side panes: split the viewer area (like VSCode), tabs draggable between
      panes; terminal area supports splits too (per the §5 layout). Closing the final
      secondary viewer tab collapses its now-empty pane.
- [x] Add a compact double-up-chevron control to the horizontal divider that expands the
      active terminal deck to the full center height. In focus mode it becomes a
      double-down-chevron and restores the exact pre-expansion divider height.
- [x] Keep terminal focus transient: hide rather than unmount the viewer, keep PTYs and
      tabs alive, do not overwrite the persisted per-workspace terminal height, and do
      not reopen maximized after relaunch.
- [x] Add the matching double-chevron control to the file-explorer divider. Collapse
      without unmounting Files/Git state or overwriting the saved explorer width, and
      let it compose with terminal focus for an almost-just-terminal layout.
- [x] Restore the viewer automatically before every file activation from Files, Git
      Changes/History/graph, rendered internal links, or a terminal path link. Activating
      an already-open tab follows the same rule.
- [x] Extend `TerminalPane` with an engine-agnostic user-activated link event. Resolve
      OSC 8 file targets and supported plain `path:line[:column]` links relative to the
      host-qualified active workspace; reject paths outside it, never execute text, and
      reveal the requested source line/column.
- [x] Keep workspace selection in one place: remove inactive-worktree jump rows from the
      right terminal rail. It lists only terminals owned by the active workspace; inactive
      terminal attention continues to roll up to the top workspace/project controls.
- [x] Keep the workspace/branch tier visible for a single checkout. Remove the redundant
      local/remote host strip; local projects need no host chrome, while the active SSH
      badge exposes status, watch mode, Change, and Disconnect/Reconnect controls.
- [x] Add a confirmed project-tab close action. Unregister without touching repository
      data, retain terminal recovery metadata, and keep one project active in v1.
- [x] Keybinding surface: the handful of core actions (cycle view mode, focus terminal
      / viewer / tree, toggle terminal focus, workspace switch) documented and rebindable
      via a simple JSON config. No keymap engine. Match bracket chords by physical key so
      macOS Option transformations remain usable, and suspend global bindings under modals.
- [x] Minimal settings UI (or settings file + reload): theme, idle threshold,
      resume-on-start behavior, Git auto-fetch interval, keybindings pointer. Reject
      blank/out-of-range thresholds visibly and let Escape remain available while editing
      the keybinding textarea.
- [x] Keep the parked Harness rail destination interactive and intentional with a calm
      coming-soon state; switching to it must preserve mounted Files/Git state.

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
- [x] Surface cached configured-upstream ahead/behind/diverged state and default-branch
      drift beside the branch selector. Distinguish "remote branch is current" from
      "the PR base moved" and label complex integration as agent work.
- [x] Add explicit Fetch plus configurable conservative auto-fetch while the Git rail is
      visible. Suppress interactive credential prompts, stop automatic retries after a
      failure, and retain an explicit retry control.
- [x] Offer Pull only for a clean, attached, behind-only branch with an upstream and no
      unsaved viewer tabs. Authorize only exact `--no-rebase --ff-only` grammar; never
      autostash, merge, rebase, force, resolve conflicts, or integrate the base branch.

### Notifications and status clarity
- [x] Give connection state, Git changed counts, and terminal attention distinct visual
      treatments. Remove the same-looking leading/trailing dots; use one consistent,
      accessible trailing attention badge with unseen-terminal counts on workspace and
      project parents.
- [x] Functionally audit attention end to end: plain BEL and supported OSC bell events,
      new output, idle-after-burst, terminal focus clearing, parent aggregation, workspace
      switching, window focus, and the quiet OS badge. Add deterministic regressions for
      every broken path found before styling it. Oversized malformed OSC sequences stay
      in bounded discard mode through their terminator and cannot invent bell attention.

### Performance & robustness pass
- [x] Profile the §3.2 gauntlet and fix regressions: 5+ churning workspaces, sustained
      terminal output, large-file open, git status storms. Add a repeatable script or
      documented manual protocol for this gauntlet so later changes can re-run it.
- [ ] Repeat the Phase 7 workspace edge matrix while polishing: terminal-created
      worktree auto-discovery and rollups, persistent single-workspace context, plain non-git
      project behavior, and cancel/confirm stale-record pruning on local and SSH hosts.
- [ ] Repeat the Phase 7.5 real-host topology with 12+ terminals across two SSH projects
      and three workspaces, then audit the remote host after quit for leftover
      `hvir-telemetry.*` directories or follower `tail` processes.
- [ ] Memory sanity: long-running session (hours, many terminals) has bounded growth;
      scrollback limits enforced.
- [x] Error surfaces: host disconnects, git failures, and renderer errors all land as
      visible-but-calm UI states, never silent failure or a white screen.

### Packaging
- [x] Use one supported distribution path: `npm install -g hvir-workbench` installs a small
      launcher plus one hidden, integrity-checked native payload. Do not also maintain
      dmg, zip, AppImage, or deb install paths. Validate an extracted replacement before
      atomically swapping it so a corrupt payload cannot delete a prior app directory.
- [x] Build Linux x64, Linux arm64, and macOS arm64 payload packages on native CI
      runners. Intel macOS and Windows are not release targets.
- [ ] Publish the first matched-version platform packages and `hvir-workbench` launcher from a tag,
      then verify install/update/remove through the public npm registry.
- [x] App icon, name, basic README with screenshots.
- [x] macOS signing/notarization: investigate and document; unsigned dev builds are
      acceptable for v1 if cost is prohibitive — record the decision.

## Acceptance criteria
- [ ] Fresh global npm installs on Linux x64, Linux arm64, and macOS arm64 run the full
      workflow (register projects, view, terminals, SSH) with no source checkout.
- [x] Theme switch is instant and consistent across chrome, code, markdown, terminal.
- [ ] On local and SSH repositories, the Git rail accurately shows the active branch,
      configured-upstream/base drift, and switches to an existing unoccupied branch only
      when both Git and hvir are clean. Fetch refreshes the model; Pull is available only
      for a clean fast-forward. Dirty, occupied, detached, diverged, authentication, and
      failed cases are safe and legible.
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
branch switch and remote fetch/clean fast-forward pull in ADR-005. New features not in
design.md — if v1 feels incomplete, the fix is an ADR conversation, not a quiet addition
here.

## Automated implementation evidence (2026-07-15)

- The final clean-tree preflight on 2026-07-16 passed seam enforcement, lint, both
  TypeScript builds, 40 test files / 282 tests, the production workflow smoke, and the
  12-terminal capacity/recovery smoke. It also caught and fixed an existing untracked
  Git tab retaining Diff mode, aligned capacity probes with the headerless terminal
  surface, and drains native PTY exit callbacks during bounded final shutdown.
- Review hardening passed seam enforcement, lint, both TypeScript builds, 40 test files /
  281 tests, and the production Electron smoke. The added regressions cover macOS
  Option-bracket matching, bounded OSC discard, ragged/truncated CSVs, line-bearing
  terminal targets, and corrupt/valid npm payload swaps; the smoke now checks modal
  shortcut isolation, visible settings validation, empty-viewer auto-collapse, and
  confirmed project unregistering with final-project protection. SSH refresh pulses retain
  cached tree contents without flashing first-load indicators.
- `npm run gauntlet` passed seam enforcement, scoped lint, both TypeScript builds, 39 test
  files / 272 tests, the production workflow smoke, and the 30-second capacity smoke.
- The capacity run mounted 12 live terminals and measured **17.7 ms p99 / 17.8 ms max**
  responsiveness across 75 transitions. Working-set growth was 50 MiB net / 106 MiB peak,
  then all 12 terminals recovered with Changes and History ready.
- Earlier Linux x64 deb/AppImage and macOS arm64 dmg/zip prototypes proved the packaged
  application and native `node-pty` layouts. Those formats are now superseded by the
  single npm launcher plus native-payload model and are no longer release products.
- The macOS arm64 npm payload packed at 160.9 MB, installed through its real postinstall
  extraction into a clean temporary npm prefix, verified its native architecture, and
  passed the complete packaged-app smoke workflow through the installed `hvir` launcher,
  including its project-path argument. The launcher also passed its
  `hvir --version`/help contract and both packages passed `npm publish --dry-run`.
- The local post-gauntlet teardown audit found no telemetry helper directories, follower
  `tail` processes, PTYs, Electron app processes, Docker containers, or build volumes.
- The final Git/connection polish keeps registered nested worktree roots out of their
  parent's status/count/branch-safety model, leaves blocked branch menus inspectable,
  collapses branch-point detail by default, reserves connection badges for SSH, and makes
  the active SSH badge the connection-control surface instead of repeating host identity
  above the left rail.

## Manual release acceptance remaining

The unchecked items are deliberately not inferred from automation: repeat the workspace
edge matrix on current local and SSH builds; run the 12+ terminal real-host SSH topology
and teardown audit; complete the two-hour memory soak; exercise branch switching and a
fresh global npm install against a real SSH project on each supported architecture; and
obtain the final view-first
thesis review. Phase 8 stays **in progress** until those checks are recorded.
