# hvir

**H**arness · **V**iew · **I**nteract · **R**espond

A lightweight, view-first workbench for agentic development: a beautiful code + git
explorer wrapped around the terminals where agents (Claude Code, Codex, …) do their
work.

> **Status: foundation only, not usable yet.** Phase 1 is implemented: the Electron
> shell and core architecture seams run, but the viewer and terminal UI have not landed.

## What / why

hvir is **not an IDE and not an editor** — it's a *viewer*. It serves one workflow:
*"I hand off to agents frequently, but I like to stay in the loop and know what's going
on."*

The existing options bracket the problem without solving it:

- **tmux** is too hands-off — you can't explore a codebase or its git history from a
  grid of terminals.
- **VSCode** is more than we want — a full IDE that strains under 5+ open directories
  and many agent terminals, when all we need is to *watch and read*.
- **The agent-tool cluster** (Conductor, Vibe Kanban, Claude Squad, …) is
  harness-first: great at running parallel sessions, weak at beautifully exploring what
  the agents actually did.

hvir inverts that last one: a fast, gorgeous code/git explorer that happens to host your
agent terminals. Working-tree diffs ("what did the agent change"), auto-titled
terminals, and is-it-waiting-for-me notification dots are first-class; editing beyond
minor-edit-and-save is deliberately out of scope, forever.

## Design highlights

- **Nothing blocks the paint** — all heavy work (git walks, watching, tokenizing) runs
  off the render thread. "Lighter than VSCode" is a feel, not a byte count.
- **Local and SSH projects are peers** — every path is a `(host, path)` pair; remote
  support is transport, not a server.
- **Sessions survive restarts** — agent sessions resume through the harness's own
  persistence; no daemon.
- **Everything risky sits behind a seam** — terminal engine, harness CLIs, and host
  transport are swappable interfaces, not foundations.

Stack: Electron + electron-vite, React, CodeMirror 6 + Shiki, Ghostty-based terminal,
system git. Targets Linux and modern macOS.

## Documents

| Doc | What it is |
|---|---|
| [`docs/design.md`](docs/design.md) | The founding design: philosophy, non-goals, ADR-001–010, architecture, risks. Authoritative. |
| [`docs/plan/`](docs/plan/00-overview.md) | Plan of Record: phased implementation plan with task checklists. |
| [`AGENTS.md`](AGENTS.md) | Ground rules for AI agents working in this repo. |

## Contributing (human or agent)

Read `docs/design.md` first, then work the first unfinished phase in
`docs/plan/00-overview.md`. Architectural decisions are recorded as ADRs with rejected
alternatives — nothing is decided silently.

## Development

```sh
npm ci
npm run verify
npm run dev
```

`npm ci` also downloads Electron's platform binary and rebuilds native dependencies
for Electron's ABI. This explicit bootstrap is required by Electron 42+; if an existing
checkout is missing the binary, repair it with `npm run install:runtime`.

`npm run smoke` exercises the built Electron window, typed renderer IPC, utility process,
and local host. On a headless Linux machine, run it as
`xvfb-run -a npm run smoke`.
