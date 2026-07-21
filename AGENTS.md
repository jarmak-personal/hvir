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
product philosophy, guardrails, architecture, risk posture, and the linked ADR index.
Read the relevant canonical decision records under [`docs/adr/`](docs/adr/README.md).

**Implementation and acceptance work is tracked in GitHub issues, commits, and pull
requests.** Do not add progress checklists, status logs, or test-run evidence to ADRs.
[`docs/plan/`](docs/plan/00-overview.md) is frozen historical implementation context, not
an active tracker; do not update its checkboxes or status tables to record new work.

**Start substantive implementation from a governing GitHub issue.** Align on the problem,
product fit, architecture questions, and acceptance there before editing. A PR to `main` uses
`Closes #N`; an epic-child PR uses the exact contribution relationships documented in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Broad epics should be decomposed into independently
reviewable child issues.

**Do not spend effort drafting or creating an issue without the user's go-ahead.** An agent may
briefly propose using `hvir-create-issue`, but must wait for explicit approval before invoking
it. After drafting, it must show the exact issue and receive separate approval before publishing.

**Use `gh` for ordinary issue and pull-request operations.** When work requires the canonical
Project or repository reconciliation behavior, use the interfaces documented in
[`docs/project-management.md`](docs/project-management.md): `project:record` for Project
membership and Status, `project:kind` for label-derived Kind reconciliation, and `project:pr`
for PR-related issue Status reconciliation. These commands default to dry-run; review the plan
before passing `--apply`. Invoke only the capability the task needs, not all three ceremonially.

**Do not publish a pull request that fails locally runnable checks.** After the final changes,
run `npm run verify` before committing. Push without `--no-verify` so `.githooks/pre-push` runs;
if hooks are not installed, run that hook directly before pushing. Fix failures locally or
report an environment blocker instead of spending CI minutes on a known-bad branch.

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

## Stack (see the ADR index in design.md)

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
- Before adding behavior, trace the current owner and search for equivalent policy or helpers.
  Share stable concepts through narrow, domain-named modules; do not create generic `utils`,
  catch-all `services`, service locators, or new responsibilities in composition roots.
- When making an architectural decision, add one decision-only record under `docs/adr/`
  using its template, then add it to the index in `docs/design.md`. Keep context, decision,
  consequences, and rejected alternatives in the ADR; keep implementation tracking in the
  issue/commit/PR history.
- Keep the non-goals in §2 of the design doc in view — resist "just one more thing."
