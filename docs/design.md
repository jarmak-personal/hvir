# hvir — Design & Architecture

> A lightweight, view-first workbench for agentic development.
> A beautiful code + git explorer wrapped around the terminals you actually like.

**Status:** Draft / founding document
**Date:** 2026-07-11
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

## 4. Key decisions (ADR-style)

### ADR-001 — Electron as the shell
**Decision:** Build on Electron.
**Why:** It is what VSCode uses; we get tabbed chrome, panes, and webviews for free, with
turnkey Linux + macOS support. The "light feel" is achieved via §3.2 (threading), not by
choosing a lighter shell.
**Rejected:** Tauri (lighter RAM, but trickier terminal-canvas perf in the system webview,
and a smaller path for the terminal embed); native/GPUI (far more work, cuts against
"leverage OSS").

### ADR-002 — React on electron-vite for the render layer
**Decision:** `electron-vite` + React.
**Why:** Largest OSS component ecosystem (viewer, tree, git UI), fastest assembly of known
parts. We buy responsiveness back through §3.2 rather than through a lighter framework.
**Rejected:** Svelte / Solid (lighter runtimes, but smaller ecosystems mean more
hand-rolling; the paint-never-blocks discipline matters more than the framework's
reactivity cost).

### ADR-003 — Terminal is a swappable pane, not the foundation
**Decision:** Define a `TerminalPane` interface. Ship v1 on `ghostty-web` (Ghostty's VT
engine behind an xterm.js-shaped API), retaining plain xterm.js as the compatible
fallback. Revisit the full native libghostty widget as its versioned embedding API
stabilizes on Linux.
**Why:** Ghostty embedding is real but still moving — see §6.

#### Phase 2 addendum — 2026-07-12: GO on ghostty-web for v1

The viewer spike retires the immediate embedding risk: `ghostty-web@0.4.0` loads under
Electron's production CSP, renders a real `node-pty` shell, propagates input and resize,
and surfaces title/bell/OSC events behind `TerminalPane`. The production Electron smoke
passes on Linux and covers the real WASM engine, PTY, lazy tree, worker-highlighted
CodeMirror viewer, pane resizing, and PTY cleanup. A manual macOS pass on a MacBook Air
found normal Codex use responsive, divider dragging smooth, and watcher updates for a
new directory plus ten files immediate. One JSON-open hitch did not reproduce across
repeated fresh opens.

One Codex resize briefly hid its input row until Enter forced a redraw. PTY resize is
now trailing-debounced by 75 ms; keep the observation open for cross-TUI testing, but it
does not block v1. The scripted all-at-once sustained-output/5 MiB/watcher matrix was not
run; the product owner explicitly accepted the phase on the exploratory evidence above.

**Outcome:** ship v1 with `ghostty-web` behind `TerminalPane`. Do not take a native
libghostty dependency yet; `electron-libghostty@0.0.0` contains no usable implementation,
and upstream libghostty remains unversioned. Fall back to `@xterm/xterm` if later load
testing exposes a blocker, without changing code above the pane seam.

### ADR-004 — Code viewer: CodeMirror 6 + Shiki
**Decision:** CodeMirror 6 for the view surface, Shiki for highlighting.
**Why:** Shiki (TextMate grammars + VSCode themes) is the "renders beautifully" payoff.
CodeMirror 6 is lighter than Monaco and its read-first posture fits us. Monaco remains a
fallback if we want VSCode's exact editor feel.
**Revisit if:** we need Monaco's exact behaviors for the "minor edit" path.

### ADR-005 — Git engine: shell out to system git
**Decision:** Use the system `git` binary (via `simple-git` or thin wrappers) as the only
git engine, run in a utility process.
**Why:** Anyone using this tool has git installed by definition. It's what VSCode does,
it's always correct — including worktrees, which are our workspace unit (ADR-008) — and
we buy performance back through the off-thread boundary, not the engine.
**Rejected:** isomorphic-git (weak worktree support and slow on large repos — a landmine
given ADR-008); libgit2 bindings (native build complexity for marginal gain).
**Revisit if:** history browsing measurably lags on big repos.

### ADR-006 — Session recovery: harness resume, not a daemon
**Decision:** Recover agent sessions through the harness's own persistence
(`claude --resume`, `codex resume`), not by keeping PTYs alive in a daemon. hvir
generates a session UUID at launch and passes it in (`claude --session-id <uuid>`), so
resume is deterministic — no scraping or guessing. Two seams keep this evolvable:
1. All PTY spawning goes through one narrow **PTY supervisor** module, so a daemon could
   replace it out-of-process later without touching the UI.
2. Harness-specific behavior (launch flags, resume commands, title conventions) lives
   behind a **`HarnessAdapter`** interface, mirroring `TerminalPane`. Harness quirks
   never leak past it.

**Why:** The thing worth preserving isn't the PTY — it's the conversation state, and the
harnesses already persist that on disk for free. What resume loses vs a daemon
(scrollback, plain non-harness shells, mid-turn work) is acceptable for the rare
"hvir restarted" event.
**Rejected:** a PTY daemon (real complexity for a rare event; *deferred, not foreclosed* —
the supervisor seam keeps the door open); tmux control mode (we'd be rendering tmux's
view of the terminal, fighting the entire Ghostty investment).

### ADR-007 — Per-tab view mode: rendered / source / diff
**Decision:** Every viewer tab has a single three-state **view mode** — *rendered /
source / diff* — with a visible segmented control and one keybinding that cycles it.
The **default** is inferred: markdown, mermaid, and HTML open rendered ("this is an md,
render it" — never a "preview" verb, never leaving hvir); a file opened from the git
panel opens in diff mode; from the file tree, source (or rendered). But the mode is
always one keystroke away, always visible, and sticky per tab. Diff mode gets its own
small **base selector**: working tree vs HEAD vs branch-point — branch-point being the
"what did the agent do on this worktree" view.
**Why:** This is what "renders beautifully" actually means: *the right renderer,
automatically, with zero friction* — not visual noise. And it unifies rendering with
file⇄diff swapping into one model. Defaults are smart; controls are always exposed —
the system must never feel smarter than the user.
**Rejected:** separate preview commands/panes (VSCode's `Ctrl+Shift+V` friction); fully
automatic mode switching with no visible, overridable control.

### ADR-008 — Workspaces: project → worktree tiers
**Decision:** A two-tier model. The **project** (the main repo) is the *registration*
unit — the thing you add to hvir. **Worktrees** are *discovered* children
(`git worktree list`), each one a workspace. The tier collapses when trivial — a project
with only its main checkout shows no worktree layer — and a plain non-git directory is a
degenerate single-workspace project, so the model has no special cases.
**Why:** The project boundary is the one harnesses care about (CLAUDE.md, config, trust
are project-scoped). It gives notifications a natural rollup path (terminal → worktree →
project). And because worktrees are *discovered, never managed*, hvir stays out of
worktree lifecycle entirely — protecting the "not an orchestrator" non-goal (§2). New
agent workspaces simply appear.
**Rejected:** flat workspace-per-directory (loses the project boundary); hvir-managed
worktree creation/cleanup (one step from branch naming and merge-back — orchestration
creep).

### ADR-009 — Notifications: focus clears, parents aggregate
**Decision:** One rule, no special cases: **a dot is cleared by focusing the thing that
raised it; parents only aggregate their children's unseen dots.** No dot on the terminal
you're currently focused in (focused = seen). The active project tab *can* still show a
dot when a non-focused terminal inside it raises one — that's signal, not noise (you're
reading a diff in workspace A while terminal 3 finishes).
**Signals, in order of value:**
1. **Idle-after-burst** — no PTY output for N seconds following a burst: "the agent
   stopped and is waiting for me." The signal the user actually wants.
2. **Bell** (OSC 9 / BEL) — explicit, but depends on the user's harness settings; never
   the only channel.
3. **New output since last focus** — ambient; near-permanently lit for streaming agents,
   so lowest visual priority.

**Rejected:** suppressing rollups on the active parent ("you're already here") —
special-casing is exactly where the system starts feeling smarter than the user.

### ADR-010 — Remote projects: `ProjectHost` seam, host-qualified paths, no remote server
**Decision:** Every project (ADR-008) is registered *on a host*. All filesystem, git,
PTY, and watch operations go through a **`ProjectHost`** interface — `exec`, `spawnPty`,
`read`/`write`/`list`, `watch` — with two implementations: **`LocalHost`** (the default;
local projects are just the degenerate case) and **`SshHost`** (`ssh2`: exec channels +
SFTP). From day one, every path in the codebase is a **`(host, path)` pair** — no bare
string paths anywhere, even while only `LocalHost` exists. A mixed projects bar (local,
sshmachine1, sshmachine2) is the normal case, not a mode.
**Why:** hvir has no extension host, LSP, or debugger — the things that force VSCode to
install `vscode-server` — so remote support is *transport, not a server*. ADR-005 and
ADR-006 already made the expensive parts transport-agnostic: system git becomes
`ssh host git -C <path> ...`, the PTY supervisor spawns `ssh -t`, and `HarnessAdapter`
resume works unchanged. Rendering/tokenizing run locally on fetched bytes, so per §3.2
remote latency degrades *freshness*, never *responsiveness*. The one thing that cannot
be retrofitted cheaply is path handling — hence host-qualified paths now, SSH
implementation as an early milestone (§8), not a v2 wish.
**Watching:** polling first (open tabs + git status only — hvir's watch needs are
modest); optionally stream `inotifywait -rm` over an exec channel where the host has it.
Never a persistent installed remote agent.
**Rejected:** a vscode-server-style remote daemon (heavy machinery hvir doesn't need);
SSHFS/FUSE mounts (system dependency, poor watch semantics, and they hide remoteness
from git and PTYs); local-only v1 with bare string paths (the retrofit touches
everything).

---

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

The `ProjectHost` boundary (ADR-010) lives in the utility layer: the git engine, file
watcher, and PTY supervisor all talk to a `LocalHost` or `SshHost`, never to the
filesystem directly.

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
| Session recovery | harness resume via **`HarnessAdapter`** | ADR-006 |
| Remote projects | **`ProjectHost`**: `LocalHost` / `SshHost` (`ssh2`) | ADR-010; every path is `(host, path)` |

### UI layout
```
┌────────────────────────────────────────────────────────────────────┐
│ Projects bar — project tabs (host badge, dots/changed-count        │
│ rollups); worktree workspace tier beneath, collapsed when trivial  │
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

**Spike result:** accepted 2026-07-12; `ghostty-web` is the v1 engine. See the ADR-003
Phase 2 addendum for evidence and retained caveats.

---

## 7. Agent-aware features (the differentiator)

### Auto-titled terminals
Terminals already emit OSC 0/2 title sequences, and CC/Codex set them. We read those and
label the right-rail terminal list automatically — no manual naming. (Title conventions
live in `HarnessAdapter` — ADR-006.)

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

> **Plan of Record:** this path is broken into executable phases with task checklists in
> [`docs/plan/`](plan/00-overview.md). The plan implements this document; this document
> stays authoritative.

1. **Spike (the risk):** Electron + React shell → one file tree + one CodeMirror/Shiki
   viewer + **one ghostty-web terminal pane.** Acceptance = terminal feels good, renders
   fast, UI never stalls.
2. **Tabs + view modes** — VSCode-style tabbed viewer with the rendered/source/diff
   mode control (ADR-007); open tabs live-reload when agents edit files underneath.
3. **SSH hosts** — remote terminals, browse/read/save, remote git, all through
   `ProjectHost` (ADR-010). Polling watcher to start; reconnect + auth UX.
4. **Git explorer** — working-tree and branch-point diffs first (the "what did the
   agent change" view), then history/blame. System git, off-thread (ADR-005).
5. **Notification + auto-title system** — §7, ADR-009; `HarnessAdapter` +
   session recovery (ADR-006).
6. **Workspaces** — project → worktree model + rollups (ADR-008).
7. **Polish** — themes, side-by-side panes, mermaid/JSON renderers.

*(v2 parking lot: harness viewer side tab — tokens, usage, skills, MCPs.)*

---

## 9. Open questions

- How much of the "minor edit" path do we actually need in v1 — save-in-place only, or
  also basic multi-file find/replace? Keep minimal.
- macOS vs Linux terminal-embed parity — track the embedded apprt Linux work.
- Idle-after-burst threshold (ADR-009) — fixed N seconds, or tuned per harness via
  `HarnessAdapter`?
- Session-id flags per harness (`claude --session-id` etc.) — verify exact CLI surface
  for each supported harness when building `HarnessAdapter`.
- Remote terminal survivability across SSH drops (drops are common; hvir restarts are
  rare) — optional `dtach`/`abduco` wrapper on the remote end? Unlike tmux they're
  transparent proxies with no rendering layer, so Ghostty still renders the harness
  directly. Interacts with ADR-006 resume.
- Remote watch strategy per host — polling vs `inotifywait` stream; capability-detect
  at connect time?

---

## 10. References

- libghostty roadmap — https://mitchellh.com/writing/libghostty-is-coming
- awesome-libghostty (embed projects) — https://github.com/Uzaaft/awesome-libghostty
- Ghostling (embed example) — https://github.com/ghostty-org/ghostling
- Embedded apprt / Linux support discussion — https://github.com/ghostty-org/ghostty/discussions/11722
- parallel-code (prior art) — https://github.com/johannesjo/parallel-code
