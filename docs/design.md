# hvir — Design & Architecture

> A lightweight, view-first workbench for agentic development.
> A beautiful code + git explorer wrapped around the terminals you actually like.

**Role:** Living product/design overview
**Origin:** 2026-07-11
**Targets:** Linux (primary), modern macOS (primary). Windows only if incidental.

---

## 1. What this is (and the wedge)

hvir is **not an IDE and not an editor**. It is a *viewer* — a fast, beautiful way to
explore a codebase, its git history, and the terminals where agents (Claude Code, Codex,
etc.) are doing work.

The workflow it serves: **"I hand off to agents frequently, but I like to stay in the
loop and know what's going on."** Pure-terminal approaches (tmux) are too hands-off — you
can't explore a codebase or git history the way VSCode lets you. But VSCode is *more than
we want*: it's a full IDE, it strains with 5+ open directories and many terminals, and it
doesn't render as beautifully as something built view-first.

### The gap in the market

The current cluster of agent tooling (Conductor, Nimbalyst, parallel-code, Vibe Kanban,
Claude Squad) is **harness-first, exploration-second** — great at *running* parallel agent
sessions, weak at *beautifully exploring what they did*. hvir inverts that: a gorgeous
code/git explorer that happens to host your agent terminals. That inversion is the wedge.

---

## 2. Non-goals (scope guardrails)

Scope creep is endemic to this kind of tool — "just one more thing" is always tempting.
These are the lines we hold:

- **No real editing.** "Minor edit + save" only. The moment we add serious editing
  (LSP, refactors, debugger, extension host) we are rebuilding VSCode and inheriting its
  weight. Editing is the guardrail; **surfacing information is not.**
- **No extension host / plugin platform** (at least through v1).
- **No language servers, no debugger, no build/task system.**
- **Not a session orchestrator.** We host and observe terminals; we don't try to
  out-orchestrate the dedicated worktree managers. (We may *use* worktrees as our
  workspace unit — see §7 — but that's ergonomics, not orchestration.)

Note: the v2 "harness viewer" (tokens, usage, skills, MCPs) is **on-philosophy**, not
scope creep — it is read-only telemetry, still view-first. It's parked for v2 for focus,
not because it violates the guardrail.

---

## 3. Design principles

1. **Light is a feel, not a byte count.** We accept Electron's RAM cost. "Lighter than
   VSCode" means *fewer features and instant responsiveness*, not a smaller binary.
2. **Nothing blocks the paint.** All heavy work — git log walks, file watching across
   workspaces, syntax tokenizing, large-file reads — runs off the render thread (Electron
   utility processes / workers). The UI is always instantly responsive even when a
   workspace is churning. This perceived snappiness is ~90% of the "lighter" feel.
3. **View-first, edit-second.** Rendering quality is a feature. Optimize for the reading
   experience.
4. **Agent-aware by default.** Auto-titled terminals and at-a-glance notifications are
   first-class, not afterthoughts. This is what makes it *feel built for* agentic work.
5. **Swappable terminal.** The terminal engine is an interface, not a foundation
   (see §6).

---

## 4. Key decisions

Architecture decisions are canonical, decision-only records under
[`docs/adr/`](adr/README.md). Implementation and acceptance are tracked only in GitHub
issues, commits, and pull requests.

This index deliberately retains the former `design.md#adr-NNN-…` anchors. Existing links
therefore land on the matching entry below, whose title links to the canonical record.

### [ADR-001 — Electron as the shell](adr/ADR-001-electron-shell.md)

Electron provides the cross-platform desktop shell; responsiveness comes from keeping heavy
work off the render thread.

### [ADR-002 — React on electron-vite for the render layer](adr/ADR-002-react-electron-vite.md)

React and electron-vite provide the render/build layer while feature models and expensive
work stay outside the renderer root.

### [ADR-003 — Terminal is a swappable pane, not the foundation](adr/ADR-003-swappable-terminal-pane.md)

`TerminalPane` isolates engine choice, terminal-focused layout, and typed file-link
activation from the rest of the workbench.

### [ADR-004 — Code viewer: CodeMirror 6 + Shiki](adr/ADR-004-codemirror-shiki-viewer.md)

CodeMirror supplies the read-first surface and Shiki supplies TextMate/VS Code-quality
highlighting without turning hvir into an IDE.

### [ADR-005 — Git engine: shell out to system git](adr/ADR-005-system-git-engine.md)

System Git runs behind an off-thread engine and a main-owned `ProjectHost` broker; the few
mutations hvir exposes are exact, bounded navigation operations.

### [ADR-006 — Session recovery: harness resume, not a daemon](adr/ADR-006-exact-harness-recovery.md)

The PTY supervisor and providers recover exact harness conversations from provider-owned
persistence; hvir does not guess ambient sessions or preserve PTYs in a daemon.

### [ADR-007 — Per-tab view mode: rendered / source / diff](adr/ADR-007-explicit-view-modes.md)

Every tab exposes one visible, sticky representation mode with predictable defaults and
sandboxed HTML rendering.

### [ADR-008 — Workspaces: project → worktree tiers](adr/ADR-008-project-worktree-workspaces.md)

Host-qualified registered projects own discovered worktree workspaces without making hvir a
worktree orchestrator.

### [ADR-009 — Notifications: focus clears, parents aggregate](adr/ADR-009-hierarchical-attention.md)

Terminal focus is the single clearing rule; workspace/project and OS surfaces only aggregate
the appropriate unseen child attention.

### [ADR-010 — Remote projects: `ProjectHost` seam, host-qualified paths, no remote server](adr/ADR-010-project-host-remote-boundary.md)

All project operations and paths are host-qualified behind `ProjectHost`; SSH remains a
bounded transport owned by one logical host, not an installed remote service.

### [ADR-011 — Distribution: one npm launcher, native payloads](adr/ADR-011-npm-native-payload-distribution.md)

One npm launcher selects integrity-checked native payloads for the supported Linux and
Apple-silicon macOS targets.

### [ADR-012 — Harness providers and launch profiles, not an extension host](adr/ADR-012-harness-providers-launch-profiles.md)

Trusted main-owned providers supply exact harness semantics; data-only profiles customize
launches without opaque shell commands or a third-party extension platform.

### [ADR-013 — User-activated loopback web panes over `ProjectHost` routes](adr/ADR-013-user-activated-loopback-web-panes.md)

Explicit terminal-link activation creates a bounded, authenticated, workspace-owned route to
a hostile isolated web pane while preserving remote loopback origins.

### [ADR-014 — Modular monolith ownership and dependency discipline](adr/ADR-014-modular-monolith-ownership.md)

Feature ownership, inward dependency direction, typed resource lifetimes, explicit style
order, seam checks, and blocking hotspot ratchets govern the existing process boundaries.

### [ADR-015 — Missing resume artifacts block implicit fresh launches](adr/ADR-015-missing-resume-artifact-blocks-fresh-launch.md)

A requested exact resume whose qualified provider artifact is missing remains visibly
unavailable without spawning a fresh harness or replacing the retained recovery identity.

### [ADR-016 — Bounded local runtime diagnostics](adr/ADR-016-bounded-local-runtime-diagnostics.md)

Fixed-schema, content-free diagnostic evidence flows through one bounded local owner while
feature recovery stays feature-owned, workbench health remains separate from terminal attention,
and diagnostic sessions stay explicit, droppable, and local. The bounded Long Tasks experiment
and its opt-in recommendation are recorded in the
[renderer responsiveness evaluation](renderer-responsiveness-evaluation.md). The owner-by-owner
[layout-integrity evaluation](layout-integrity-evaluation.md) retains layout postconditions as
pure or focused Electron conformance and promotes no runtime detector.

### [ADR-017 — Defer direct diagnostic report delivery to harnesses](adr/ADR-017-defer-direct-diagnostic-report-delivery.md)

Preview plus explicit Copy or Save remains the report boundary until a bundled provider can prove
exact-session semantic submission, truthful host and attachment behavior, and revocable lifecycle
semantics without generic PTY injection or new persistence.

### [ADR-018 — Script-free first-use native payload preparation](adr/ADR-018-script-free-native-payload-preparation.md)

Platform packages carry no lifecycle scripts; the launcher verifies and atomically prepares one
common archived payload lifecycle in a bounded per-user cache while npm retains installation,
platform selection, integrity, and provenance authority.

### [ADR-019 — Two explicit recovery skips forget the hvir record](adr/ADR-019-two-explicit-recovery-skips-forget-record.md)

One explicit skip retains and marks a decision-ready recovery record; a second consecutive skip
forgets only hvir's host-qualified metadata while provider-native recovery remains untouched.

## 5. Architecture

### Process model
```
┌─────────────────────────────────────────────────────────────┐
│ Main process (Electron)                                      │
│  - window/lifecycle, menus, workspace registry               │
│  - IPC broker                                                │
└───────────────┬───────────────────────────┬─────────────────┘
                │                            │
     ┌──────────▼──────────┐      ┌──────────▼──────────────────┐
     │ Renderer (React)    │      │ Utility processes / workers │
     │  - file explorer    │◄────►│  - git engine (log/diff)    │
     │  - git explorer     │ IPC  │  - file watcher (chokidar)  │
     │  - tabbed viewer    │      │  - syntax tokenizer (Shiki) │
     │  - terminal panes   │      │  - large-file / blob reads  │
     │  - workspaces bar   │      └─────────────────────────────┘
     └─────────────────────┘
     (terminal PTYs spawned in main/utility, streamed to panes)
```

The rule from §3.2: if it can stall, it does not live in the renderer.

The `ProjectHost` boundary (ADR-010) is main-owned. The Git utility process proxies its
bounded host operations back through main; watchers and the PTY supervisor also use the
registered `LocalHost` or `SshHost`. Renderer features reach these capabilities only
through typed IPC and never access the filesystem directly.

### Component map
| Area | Choice | Notes |
|---|---|---|
| Shell | Electron + electron-vite | ADR-001/002 |
| Render layer | React | ADR-002 |
| Code viewer | CodeMirror 6 | read-first; Monaco fallback |
| Syntax highlight | Shiki | the "beautiful" payoff |
| View modes | rendered / source / diff per tab | ADR-007 |
| Markdown render | markdown-it + Shiki | rendered by default (ADR-007) |
| HTML render | webview / iframe (sandboxed) | **security req:** no node integration, strict CSP, block navigation |
| File tree | custom tree + chokidar watcher | watcher off-thread; open tabs live-reload on external change |
| Git engine | system `git` binary (simple-git / thin wrapper) | ADR-005; off-thread |
| Terminals | ghostty-web → libghostty | ADR-003, swappable |
| PTY | node-pty behind the **PTY supervisor** | spawned off-renderer; ADR-006 |
| Harness integration | main-owned **harness provider registry** + launch profiles | ADR-006/012 |
| Session recovery | exact harness resume via the active provider | ADR-006/012 |
| Remote projects | **`ProjectHost`**: `LocalHost` / `SshHost` (`ssh2`) | ADR-010; every path is `(host, path)` |

### UI layout
```
┌────────────────────────────────────────────────────────────────────┐
│ Projects bar — project tabs (host badge, dots/changed-count        │
│ rollups); persistent worktree/workspace context tier beneath       │
├──────────┬────────────────────────────────────────┬────────────────┤
│ Left     │ Viewer — tabs w/ view mode             │                │
│ rail     │ (rendered / source / diff),            │  Right rail    │
│          │ side-by-side splits                    │  open          │
│ file     ├────────────────────────────────────────┤  terminals,    │
│ tree /   │ Terminals (Ghostty panes,              │  auto-titled,  │
│ git      │ splits like VSCode)                    │  notification  │
│ explorer │                                        │  dots          │
└──────────┴────────────────────────────────────────┴────────────────┘
```

---

## 6. The terminal risk (resolved for v1)

Embedding *Ghostty specifically* was the founding design's one load-bearing unknown.
Phase 2 resolved the v1 delivery path; native embedding remains a future upgrade:

- **Native libghostty** is usable but remains unversioned, with API signatures and the
  embedding surface still moving; taking it directly would add native renderer and
  packaging work on both primary platforms.
- **`electron-libghostty`** is not a viable package today: its `0.0.0` tarball contains
  only package metadata and no implementation.
- **`ghostty-web`** is maintained, carries Ghostty's VT engine as WASM, and provides the
  xterm-shaped browser surface the Electron renderer needs. Phase 2 verified it on
  Linux and macOS.

**Mitigation (ADR-003):** the terminal is behind a `TerminalPane` interface. Because
`ghostty-web` is xterm.js-API-compatible, we inherit the entire mature xterm.js ecosystem
*and* Ghostty's engine, and can fall back to plain xterm.js if needed — then upgrade to
the full native libghostty widget when Linux embedding matures. The project never bets on
an unstable API.

**Current decision:** `ghostty-web` is the v1 engine behind `TerminalPane`; ADR-003 owns
the durable choice and its fallback/revisit conditions. Historical spike execution is
preserved in Git and the frozen implementation plan, not in the decision record.

---

## 7. Agent-aware features (the differentiator)

### Auto-titled terminals
Terminals already emit OSC 0/2 title sequences, and CC/Codex set them. We read those and
label the right-rail terminal list automatically — no manual naming. (Title conventions
live in `HarnessAdapter` — ADR-006.) Codex defaults its terminal title to spinner and
project, which duplicates the project rail; hvir-launched Codex sessions request its
supported `thread-title` item so the rail receives the conversation title through OSC.

### Notification dots
Raise a color dot on a terminal when it wants attention. Signals and the
focus-clears/parents-aggregate rule are ADR-009; the headline signal is
**idle-after-burst** — "the agent stopped and is waiting for me" — with bell and
new-output as secondary channels. Dots roll up terminal → worktree → project (ADR-008).

### Session recovery
Close hvir mid-run and nothing is lost: sessions resume deterministically through the
harness's own persistence (`--session-id` at launch → `--resume` on restart). ADR-006.

### The "what did the agent change" view
History/blame is table stakes; the killer view is the **working-tree and branch-point
diff** — what changed since I last looked, per worktree, one keystroke from the file
view (ADR-007). Changed-file counts roll up alongside notification dots.

### Workspaces
First-class multiple directories, without VSCode's multi-root heaviness. Two tiers:
**project** (registered) → **worktrees** (discovered), per ADR-008 — a workspace = a
worktree = a place an agent is working, with notification rollups at each tier.

---

## 8. MVP path

The founding MVP sequence established the shell, viewer, terminal, remote-host, Git,
attention, recovery, workspace, and polish surfaces described above. Its detailed phase
documents remain as [historical implementation context](plan/00-overview.md), not an
active tracker or acceptance ledger.

Current work is selected and accepted in GitHub issues. This document continues to own
the product boundary and architecture; an issue that requires a new durable architecture
choice adds or supersedes an ADR before implementation silently changes that boundary.

---

## 9. Open questions

Open product and architecture questions are tracked as GitHub issues so they have one
owner, discussion, and acceptance history. A resolved question that changes a durable
boundary becomes an individual ADR and an entry in §4. This section retains the founding
anchor for inbound links without maintaining a second research queue.

---

## 10. References

- libghostty roadmap — https://mitchellh.com/writing/libghostty-is-coming
- awesome-libghostty (embed projects) — https://github.com/Uzaaft/awesome-libghostty
- Ghostling (embed example) — https://github.com/ghostty-org/ghostling
- Embedded apprt / Linux support discussion — https://github.com/ghostty-org/ghostty/discussions/11722
- parallel-code (prior art) — https://github.com/johannesjo/parallel-code
- Electron `<webview>` API and stability warning — https://www.electronjs.org/docs/latest/api/webview-tag
- Electron `webContents` navigation, attachment, input, and proxy-auth events — https://www.electronjs.org/docs/latest/api/web-contents
- Electron security guidance for remote content — https://www.electronjs.org/docs/latest/tutorial/security
- Electron session and proxy API — https://www.electronjs.org/docs/latest/api/session
- Chromium proxy behavior for loopback origins — https://chromium.googlesource.com/chromium/src/+/312b6bf/net/docs/proxy.md
