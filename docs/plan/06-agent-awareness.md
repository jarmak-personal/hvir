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
- [ ] **Verify CLI surfaces first** (design.md §9 open question): for Claude Code —
      the flag to pre-assign a session id and the resume invocation; for Codex — the
      equivalents (`codex resume`, `--last`, session id assignment). Check current
      docs/`--help`; record findings in this doc. The adapters encode whatever is
      actually true, not what this plan remembers.
- [ ] `ClaudeCodeAdapter` and `CodexAdapter`: launch command with pre-assigned session
      UUID, resume command from a stored session id, title conventions. Keep every
      harness-specific detail inside the adapter.
- [ ] Session registry (persisted): terminal → {harness, session id, hostId, cwd,
      last-seen title}. Written by the PTY supervisor on spawn.
- [ ] Recovery flow: on app start (or host reconnect), for each registered session,
      offer resume — restart the adapter's resume command in a new PTY, same pane
      position. Auto-resume vs prompt: make it a setting, default prompt.
- [ ] "New terminal" UX: plain shell by default; one-action launch of a harness
      (adapter list) in a chosen workspace.

### Auto-titles (§7)
- [ ] Parse OSC 0/2 from the PTY stream (via `TerminalPane` events from Phase 2);
      right-rail terminal list shows live titles. Fallback title: adapter name + cwd.

### Notification dots (ADR-009 — the model is already decided)
- [ ] Signal detection per terminal, in priority order:
      **idle-after-burst** (no PTY output for N seconds following a burst — start with
      a fixed N ~3–5 s, threshold configurable; per-harness tuning via adapter is an
      open question, don't build it yet), **bell** (BEL / OSC 9), **new output since
      last focus**.
- [ ] Dot state per terminal with the clearing rule: *focusing the terminal clears its
      dot; nothing else does.* Parents (worktree, project — wired fully in Phase 7)
      only aggregate children's unseen dots. No suppression on active parents.
- [ ] Right-rail terminal list: title + dot (color/style by signal type, idle-after-
      burst most prominent).
- [ ] OS-level nudge when hvir is unfocused (badge/urgency hint), driven by the same
      dot state. Keep minimal.

## Acceptance criteria
- [ ] Start a Claude Code session via hvir, quit hvir mid-task, relaunch: resume
      restores the conversation in place.
- [ ] Same flow on an SSH host after a network drop (composes with Phase 4).
- [ ] Terminal titles update live as CC/Codex set them; plain shells get sane fallbacks.
- [ ] An agent finishing its turn raises an idle-after-burst dot within N seconds; a
      streaming agent does not flicker dots; focusing the terminal clears it; the
      right-rail shows it while you're reading a file elsewhere in the same project.
- [ ] Bell from any terminal raises the bell-style dot.
- [ ] Adapter quirks stay contained: grep shows no harness-specific strings outside the
      adapter modules.
- [ ] Status table updated.

## Non-goals
Harness telemetry (tokens, usage, skills, MCPs) — v2 parking lot, hold the line.
Orchestration of any kind (spawning agents on a schedule, queueing prompts). Per-harness
idle tuning (open question — revisit with real usage data).
