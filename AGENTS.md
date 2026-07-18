# AGENTS.md

Guidance for AI agents working in this repository.

## What is hvir?

**hvir** = **H**arness · **V**iew · **I**nteract · **R**espond.

A lightweight, **view-first** workbench for agentic development: a beautiful code + git
explorer wrapped around the terminals (harnesses like Claude Code / Codex) you actually
like. It is **not an IDE and not an editor** — it's a viewer, tuned for the "I hand off to
agents frequently but stay in the loop" workflow.

The name is the thesis: watch the **harness**, **view** the codebase/git, **interact**
lightly, **respond**. VSCode is more than we want; tmux is too hands-off. hvir sits
between them.

**Read [`docs/design.md`](docs/design.md) before doing substantive work** — it holds the
philosophy, the ADRs (with rejected alternatives), the architecture, and the one real
technical risk (Ghostty embedding).

**Implementation work follows the Plan of Record in [`docs/plan/`](docs/plan/00-overview.md)**
— start at `00-overview.md`, pick the first unfinished phase, and check off tasks as you
complete them.

## Hard constraints (do not violate without explicit sign-off)

- **No real editing.** "Minor edit + save" only. No LSP, debugger, refactors, extension
  host, task/build system. Editing is the guardrail; *surfacing information is not* —
  read-only telemetry (the v2 "harness viewer") is on-philosophy.
- **Nothing blocks the paint.** Heavy work — git walks, file watching, syntax tokenizing,
  large reads — runs off the render thread (utility processes / workers). The UI is always
  instantly responsive. This is how we earn "lighter than VSCode" (a *feel*, not a byte
  count — Electron's RAM cost is accepted deliberately).
- **The terminal is a swappable pane, not the foundation.** Keep it behind the
  `TerminalPane` interface. Never bet the project on an unstable libghostty API.
- **Respect the seams.** All PTY spawning goes through the **PTY supervisor**; all
  harness-specific behavior (launch flags, resume commands, title conventions) stays
  behind the main-owned **harness provider registry/providers** (the evolved
  `HarnessAdapter` seam); the terminal stays behind **`TerminalPane`**; every
  filesystem/git/PTY/watch operation goes through **`ProjectHost`**
  (`LocalHost`/`SshHost`). Harness quirks never leak past their adapter.
  (ADR-003, ADR-006, ADR-010)
- **Every path is host-qualified.** Paths are `(host, path)` pairs everywhere — no bare
  string paths, even in local-only code. Projects live on hosts; local is just the
  default host. (ADR-010)
- **Smart defaults, exposed controls.** View modes (rendered/source/diff per tab) and
  notifications (focus clears, parents aggregate) follow fixed, visible rules — no
  hidden magic, no special-casing. (ADR-007, ADR-009)

## Stack (see ADRs in design.md)

- **Shell:** Electron + electron-vite
- **Render layer:** React
- **Code viewer:** CodeMirror 6 + Shiki (Monaco fallback)
- **Git engine:** system `git` binary, off-thread (ADR-005)
- **Terminals:** ghostty-web → libghostty (swappable)
- **Harness integration:** main-owned provider registry + launch profiles (ADR-006/012)
- **Session recovery:** exact provider-owned harness resume, no daemon (ADR-006/012)
- **Workspaces:** project (registered) → worktrees (discovered) (ADR-008)
- **Remote projects:** SSH via `ssh2` behind `ProjectHost`; no remote server (ADR-010)
- **Targets:** Linux (primary), modern macOS (primary). Windows only if incidental.

## Conventions

- Prefer leveraging mature OSS over rebuilding.
- When making an architectural decision, record it as an ADR in `docs/design.md` (with the
  rejected alternatives and *why*) rather than deciding silently.
- Keep the non-goals in §2 of the design doc in view — resist "just one more thing."
