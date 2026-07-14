# hvir — Plan of Record (overview)

This directory is the engineering implementation plan for hvir. The PRD is
[`docs/design.md`](../design.md) — it holds the philosophy, ADR-001 through ADR-010, the
architecture, and the risks. **Nothing in this plan overrides it.** If plan and design
conflict, the design doc wins; if you must deviate, record why (see Ground rules).

## How to work this plan (read this first, low-context agent)

1. Read [`AGENTS.md`](../../AGENTS.md) (hard constraints) and [`docs/design.md`](../design.md)
   (at minimum §2, §3, and every ADR referenced by your phase).
2. Phases run in order. Pick the first phase whose status below isn't `done`. Within a
   phase, tasks are roughly ordered but not strictly sequential.
3. Check boxes (`- [ ]` → `- [x]`) as you complete tasks, in the same commit as the work.
4. A phase is done only when **all acceptance criteria** in its doc are checked.
   Update the status table below when a phase changes state.
5. Architectural decisions made during implementation get recorded as ADRs in
   `docs/design.md` (with rejected alternatives), not decided silently.

## Phases

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | Scaffold & core seams | [01-scaffold-and-seams.md](01-scaffold-and-seams.md) | done |
| 2 | Viewer spike (the risk) | [02-viewer-spike.md](02-viewer-spike.md) | done |
| 3 | Tabs & view modes | [03-tabs-and-view-modes.md](03-tabs-and-view-modes.md) | done |
| 4 | SSH hosts | [04-ssh-hosts.md](04-ssh-hosts.md) | done |
| 5 | Git explorer | [05-git-explorer.md](05-git-explorer.md) | done |
| 6 | Agent awareness | [06-agent-awareness.md](06-agent-awareness.md) | done |
| 7 | Workspaces | [07-workspaces.md](07-workspaces.md) | in progress |
| 8 | Polish & packaging | [08-polish-and-packaging.md](08-polish-and-packaging.md) | not started |

Dependency notes: 2 depends on 1. 3 depends on 2. Phases 4 and 5 both depend on 3 and
could run in parallel or swapped. 6 depends on 1 (seams) and benefits from 3. 7 depends
on 5 and 6. 8 is last.

## Active review queue

- [Phase 3–5 review follow-ups](03-05-review-followups.md) — macOS cold-dev stability,
  rendered links/YAML, compact source gutters, rail navigation, and Git topology graph.
  Resolve P0 before further milestone acceptance work.
- [Phase 4–5 deep-audit follow-ups](04-05-deep-audit-followups.md) — dirty-buffer safety,
  SSH lifecycle/auth reliability, Git broker and missing-path correctness, polling load,
  diff truthfulness, request races, scale, and integrated UX. Engineering work is complete;
  the real-host acceptance matrix remains open.

## Ground rules (apply to every phase)

- **Hard constraints** from AGENTS.md are non-negotiable: no real editing beyond
  minor-edit-and-save; nothing blocks the paint (heavy work off the render thread);
  respect the seams (`TerminalPane`, PTY supervisor, `HarnessAdapter`, `ProjectHost`);
  every path is a `(host, path)` pair — no bare string paths, even in local-only code.
- **Definition of done** for any task that touches code: typecheck passes, lint passes,
  the app launches, and the renderer stays responsive during the feature's heaviest
  operation.
- **Verify external surfaces at implementation time.** Package names, harness CLI flags
  (`claude --session-id`, `codex resume`), and the ghostty-web API are all moving
  targets; the plan flags these with explicit "verify" tasks. Do not trust this plan's
  memory of a third-party API over its current docs.
- **Don't gold-plate.** Each phase lists non-goals; resist "just one more thing" (§2 of
  the design doc). The v2 parking lot (harness telemetry viewer) stays parked.
