# hvir (H-veer)

**h**arness · **v**iew · **i**nteract · **r**espond

A lightweight, view-first workbench for agentic development: a polished code and Git
explorer wrapped around the terminals where Claude Code, Codex, and your shell do the
work.

![hvir showing the file tree, a working Codex session, and live terminal status](docs/screenshots/workbench-agents.png)

## Why hvir?

hvir is not an IDE and not an editor. It serves one workflow: _“I hand work to agents
frequently, but I want to stay in the loop.”_ tmux is too hands-off for exploring a
codebase and its history; a full IDE is more than this workflow needs. hvir sits between
them.

- Local and SSH projects, with auto discovered Git worktrees as workspaces.
- View files, rendered Markdown, source, diffs, blame, changes, history, or the commit graph
- Multiple shell, Claude Code, and Codex sessions split, recover, resume, and report
  attention without a daemon.
- Small ui elements try to keep the viewer focused on content instead of chrome.
- Dark/light themes, viewer and terminal splits, three-state pane controls, and
  configurable core shortcuts.
- Lightweight is a feel: heavy filesystem, Git, watching, and telemetry work stays off the render
  thread.

## Install

Install hvir from its latest GitHub Release, then launch it from any directory:

```sh
curl -fsSL https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh | bash
hvir .
```

The installer selects and verifies the release's native package for Linux x64, Linux arm64,
or Apple-silicon macOS before invoking the platform installation step.

hvir does expect the system `git` binary. Claude Code and Codex launch options use those CLIs
from the selected host's login-shell environment; plain shells work without either.

## One application, many views

The same workspace can move from reading to review to a terminal-focused handoff without
turning the workbench into an IDE.

| Rendered documentation | Branch-point diff |
| --- | --- |
| [![hvir rendering the project README beside its file tree](docs/screenshots/rendered-markdown.png)](docs/screenshots/rendered-markdown.png) | [![hvir comparing a branch-point diff with the Git changes rail](docs/screenshots/branch-point-diff.png)](docs/screenshots/branch-point-diff.png) |
| s| See exactly what changed from the branch point, with Git context kept close. |
| **Terminal focus** | **Live HTML beside the harness** |
| [![hvir with a Codex terminal maximized across the workbench](docs/screenshots/terminal-focus.png)](docs/screenshots/terminal-focus.png) | [![hvir rendering an interactive HTML page above its originating agent terminal](docs/screenshots/live-html-viewer.png)](docs/screenshots/live-html-viewer.png) |
|  | Inspect agent-built output in the same workspace and conversation that produced it. |


## Feedback and project tracking

hvir uses GitHub Issues and Pull Requests as agent-friendly items, owned by the maintainers.

Public questions and problem reports belong in the
[Q&A Discussions](https://github.com/jarmak-personal/hvir/discussions/categories/q-a), while
proposals should go in [Ideas](https://github.com/jarmak-personal/hvir/discussions/categories/ideas).

## Development

Development requires Node 24 or newer; release CI uses Node 24.

Start with the [contributor guide](CONTRIBUTING.md). Substantive implementation is discussed in
a governing issue before code or a pull request; the repository also includes optional,
contributor-only agent skills for creating and implementing issues.

```sh
npm ci
npm run verify
npm run smoke
npm run smoke:capacity
npm run performance:capacity  # controlled machine only
npm run dev
```

`npm ci` downloads Electron and rebuilds native dependencies for Electron's ABI. On a
headless Linux machine, run the Electron smoke under `xvfb-run`.

Refs:
- [performance gauntlet](docs/phase8-performance-gauntlet.md) and
- [packaging guide](docs/packaging.md) for release acceptance.

## Project documents

| Document | Purpose |
| --- | --- |
| [Design and ADR index](docs/design.md) | Product philosophy, hard boundaries, architecture, and decision index |
| [Architecture decisions](docs/adr/README.md) | Canonical decision-only ADR records and template |
| [Historical implementation plan](docs/plan/00-overview.md) | Frozen early implementation context; active work lives in GitHub issues |
| [Contributor guide](CONTRIBUTING.md) | Issue-first workflow, architecture discipline, and verification |
| [GitHub project management](docs/project-management.md) | Canonical labels, normalized planning records, and Project automation commands |
| [AGENTS.md](AGENTS.md) | Repository rules for AI collaborators |
| [CLAUDE.md](CLAUDE.md) | Claude entrypoint for the shared repository instructions |

                                           
## License

hvir is available under the [MIT License](LICENSE). See
[Third-party notices](THIRD_PARTY_NOTICES.md) for software redistributed with hvir,
including the locally modified terminal runtime.
