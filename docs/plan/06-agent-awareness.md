# Phase 6 — Agent awareness

**Read first:** [`00-overview.md`](00-overview.md); design.md §7 (the differentiator),
ADR-006 (session recovery, `HarnessAdapter`), ADR-009 (notification model — implement
it exactly; the clearing rule and signal priorities are decided).

## Goal

The features that make hvir feel *built for* agentic work: real harness adapters with
deterministic session recovery, auto-titled terminals, and the notification-dot system.
After this phase, closing and reopening hvir mid-run loses nothing, and a glance tells
you which agent wants you.

## Tasks

### Harness adapters (ADR-006)
- [x] **Verify CLI surfaces first** (design.md §9 open question): for Claude Code —
      the flag to pre-assign a session id and the resume invocation; for Codex — the
      equivalents (`codex resume`, `--last`, session id assignment). Check current
      docs/`--help`; record findings in this doc. The adapters encode whatever is
      actually true, not what this plan remembers.
      Verified locally on 2026-07-13: Claude Code 2.1.207 exposes `--session-id <uuid>`
      and `--resume <uuid>`. Codex CLI 0.144.3 exposes `codex resume [SESSION_ID]` and
      `--last`, but no launch-time id assignment or direct id handoff. The Codex adapter
      identifies one new persisted `session_meta` record using cwd, originator, launch
      time, and filename/payload UUID checks. Ambiguity fails closed; global `--last`
      remains incorrect with multiple terminals. See the ADR-006 addendum.
- [x] `ClaudeCodeAdapter` and `CodexAdapter`: launch command with pre-assigned session
      UUID, resume command from a stored session id, title conventions. Keep every
      harness-specific detail inside the adapter. Claude pre-assigns its id. Codex uses a
      serialized, bounded post-launch discovery window and only enables resume after one
      exact id is identified.
      hvir-launched Codex terminals request the canonical `thread-title` terminal-title
      item. Codex updates it after `/rename`; unnamed threads intentionally emit their
      UUID until Codex has a real thread name.
- [x] Session registry (persisted): terminal → {harness, optional exact session id,
      hostId, cwd, last-seen title}. Written on confirmed supervisor spawn. Harness
      sessions resume exactly when identified; provisional harness records restart fresh,
      and plain-shell records recreate a fresh shell in place.
- [x] Recovery flow: on app start (or host reconnect), for each registered session,
      offer restore — restart the harness adapter's exact resume command or recreate a
      plain shell in a new PTY, same pane position. Auto-restore vs prompt: make it a
      setting, default prompt.
- [x] "New terminal" UX: plain shell by default; one-action launch of a harness
      (adapter list) in a chosen workspace.

### Terminal lifecycle hardening
- [x] Make initial PTY output lossless: retain a small bounded replay buffer between
      supervisor spawn and the renderer's first attach, then drain it in order. This
      closes the Phase 2 attach-after-spawn microtask gap without unbounded scrollback.
- [x] Replace Phase 2's single-renderer `disposeAll` reload cleanup with explicit
      webContents/window ownership per terminal before multiple terminals land.

### Auto-titles (§7)
- [x] Parse OSC 0/2 from the PTY stream (via `TerminalPane` events from Phase 2);
      right-rail terminal list shows live titles. Fallback title: adapter name + cwd.

### Context pressure (explicitly promoted from the v2 parking lot)
- [x] Show a stable per-harness context meter in the terminal rail. Codex reads
      structured current-usage records from the exact rollout file already established
      by session discovery; parsing and observation stay off-renderer and behind
      `HarnessAdapter` / `ProjectHost`. Use neutral below 40%, amber at 40–69%, red at
      70%+. Claude follows the exact preassigned transcript and shows a neutral current
      token count because its authoritative window is unavailable there. Use `--` when
      no trustworthy source is available. Do not guess model windows or override Claude
      Code's configured statusline. See the ADR-006 addendum.

### Notification dots (ADR-009 — the model is already decided)
- [x] Signal detection per terminal, in priority order:
      **idle-after-burst** (no PTY output for N seconds following a burst — start with
      a fixed N ~3–5 s, threshold configurable; per-harness tuning via adapter is an
      open question, don't build it yet), **bell** (BEL / OSC 9), **new output since
      last focus**.
- [x] Dot state per terminal with the clearing rule: *focusing the terminal clears its
      dot; nothing else does.* Parents (worktree, project — wired fully in Phase 7)
      only aggregate children's unseen dots. No suppression on active parents.
- [x] Right-rail terminal list: title + dot (color/style by signal type, idle-after-
      burst most prominent).
- [x] OS-level nudge when hvir is unfocused (badge/urgency hint), driven by the same
      dot state. Keep minimal.

## Acceptance criteria
- [x] Start a Claude Code session via hvir, quit hvir mid-task, relaunch: resume
      restores the conversation in place.
- [x] Same flow on an SSH host after a network drop (composes with Phase 4). Sustained
      remote use passed; an induced disconnect was accepted as residual risk on
      2026-07-14.
- [x] Terminal titles update live as CC/Codex set them; plain shells get sane fallbacks.
- [x] An agent finishing its turn raises an idle-after-burst dot within N seconds; a
      streaming agent does not flicker dots; focusing the terminal clears it; the
      right-rail shows it while you're reading a file elsewhere in the same project.
- [x] Bell from any terminal raises the bell-style dot.
- [x] Adapter quirks stay contained: grep shows no harness-specific strings outside the
      adapter modules.
- [x] Status table updated.

## Non-goals
Harness telemetry beyond the narrow context-pressure signal (cost, usage history,
skills, MCPs, and a full harness viewer) — v2 parking lot, hold the line.
Orchestration of any kind (spawning agents on a schedule, queueing prompts). Per-harness
idle tuning (open question — revisit with real usage data).
