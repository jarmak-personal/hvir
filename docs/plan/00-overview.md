# hvir — Historical implementation plan

This directory preserves the phased plan used during hvir's early implementation. It is
not an active work tracker: do not update its checkboxes, queues, or status snapshots for
new work. GitHub issues, commits, and pull requests own implementation and acceptance.

Current product and architecture guidance lives in [`docs/design.md`](../design.md) and
the canonical decision records under [`docs/adr/`](../adr/README.md). Nothing in this
historical plan overrides them.

## How to use this history

1. Read [`AGENTS.md`](../../AGENTS.md), [`docs/design.md`](../design.md), and the canonical
   ADR linked by any historical `ADR-NNN` reference.
2. Use phase documents to understand original intent and constraints, not to infer current
   status or create new repository-side implementation tracking.
3. Put current work and acceptance in GitHub issues; put a new durable architecture choice
   in one decision-only ADR and the design index.

## Historical phase snapshot

| # | Phase | Doc | Status |
|---|-------|-----|--------|
| 1 | Scaffold & core seams | [01-scaffold-and-seams.md](01-scaffold-and-seams.md) | done |
| 2 | Viewer spike (the risk) | [02-viewer-spike.md](02-viewer-spike.md) | done |
| 3 | Tabs & view modes | [03-tabs-and-view-modes.md](03-tabs-and-view-modes.md) | done |
| 4 | SSH hosts | [04-ssh-hosts.md](04-ssh-hosts.md) | done |
| 5 | Git explorer | [05-git-explorer.md](05-git-explorer.md) | done |
| 6 | Agent awareness | [06-agent-awareness.md](06-agent-awareness.md) | done |
| 7 | Workspaces | [07-workspaces.md](07-workspaces.md) | done |
| 7.5 | SSH capacity & telemetry multiplexing | [07.5-ssh-capacity.md](07.5-ssh-capacity.md) | done |
| 8 | Polish & packaging | [08-polish-and-packaging.md](08-polish-and-packaging.md) | in progress |
| 9 | Harness providers & launch profiles | [09-harness-providers-and-launch-profiles.md](09-harness-providers-and-launch-profiles.md) | acceptance pending |

Dependency notes: 2 depends on 1. 3 depends on 2. Phases 4 and 5 both depend on 3 and
could run in parallel or swapped. 6 depends on 1 (seams) and benefits from 3. 7 depends
on 5 and 6. 7.5 depends on the SSH, agent-awareness, and workspace load exposed by phases
4, 6, and 7. Phase 8 is the last v1 phase. Phase 9 is post-v1 work and starts only after
Phase 8 acceptance; it evolves the Phase 6/7.5 harness seams without reopening the v1
packaging gate. Phase 9 implementation proceeded on an explicitly authorized feature branch
while the Phase 8 and real-host acceptance gates remain open; neither phase is represented as
done until its outstanding acceptance evidence is recorded.

## Historical review queue snapshot

- [Project-scope resilience](08-project-scope-resilience.md) — first-run folder
  selection, demand-driven file watching, plain-directory behavior, and bounded Git
  degradation. This is the active Phase 8 reliability fix for launching hvir from a
  broad directory such as a user's home.
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
  respect the seams (`TerminalPane`, PTY supervisor, harness provider registry/providers,
  `ProjectHost`);
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
