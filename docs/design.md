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
**Decision:** Define a `TerminalPane` interface. Ship on `ghostty-web` (Ghostty's VT
engine, xterm.js-compatible API) or `electron-libghostty`. Swap to the full native
libghostty widget as it stabilizes on Linux.
**Why:** Ghostty embedding is real but still moving — see §6.

### ADR-004 — Code viewer: CodeMirror 6 + Shiki
**Decision:** CodeMirror 6 for the view surface, Shiki for highlighting.
**Why:** Shiki (TextMate grammars + VSCode themes) is the "renders beautifully" payoff.
CodeMirror 6 is lighter than Monaco and its read-first posture fits us. Monaco remains a
fallback if we want VSCode's exact editor feel.
**Revisit if:** we need Monaco's exact behaviors for the "minor edit" path.

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

### Component map
| Area | Choice | Notes |
|---|---|---|
| Shell | Electron + electron-vite | ADR-001/002 |
| Render layer | React | ADR-002 |
| Code viewer | CodeMirror 6 | read-first; Monaco fallback |
| Syntax highlight | Shiki | the "beautiful" payoff |
| Markdown render | markdown-it + Shiki | auto-render on open |
| HTML render | webview / iframe (sandboxed) | auto-render on open |
| File tree | custom tree + chokidar watcher | watcher off-thread |
| Git explorer | isomorphic-git or simple-git / libgit2 | history, diff, blame |
| Terminals | ghostty-web → libghostty | ADR-003, swappable |
| PTY | node-pty (or ghostty-web's own) | spawned off-renderer |

---

## 6. The terminal risk (most important open item)

Embedding *Ghostty specifically* is the one load-bearing unknown.

- **Officially**, `libghostty` today is `libghostty-vt` — the VT parser/state engine only.
  The full "give us a surface, we render + handle input" widget is roadmapped but not the
  stable tagged API yet.
- **In practice**, full-terminal embeds exist and work: `electron-libghostty` (our target
  pattern), `ghostty-web` (Ghostty's VT engine, xterm.js-compatible API, in a webview),
  plus Avalonia/.NET, JavaFX, Godot embeds.
- **Caveat:** the embedded app-runtime started macOS-first; **Linux support is still
  landing** — and Linux is our primary target. Do not assume the full native embed is
  turnkey on Linux yet.

**Mitigation (ADR-003):** the terminal is behind a `TerminalPane` interface. Because
`ghostty-web` is xterm.js-API-compatible, we inherit the entire mature xterm.js ecosystem
*and* Ghostty's engine, and can fall back to plain xterm.js if needed — then upgrade to
the full native libghostty widget when Linux embedding matures. The project never bets on
an unstable API.

**Spike acceptance test:** one `ghostty-web` pane that feels good and renders fast. If yes,
everything else is assembly of known parts.

---

## 7. Agent-aware features (the differentiator)

### Auto-titled terminals
Terminals already emit OSC 0/2 title sequences, and CC/Codex set them. We read those and
label the right-rail terminal list automatically — no manual naming.

### Notification dots
Raise a color dot on a terminal when it wants attention:
- **Bell** (OSC 9 / BEL) — the explicit "I need you" signal.
- **New output since last focus** — the ambient "something happened here."
Roll dots up per-workspace into the top "Workspaces" bar.

### Workspaces
First-class multiple directories, without VSCode's multi-root heaviness. **Git worktrees
are the natural unit** — a workspace = a worktree = a place an agent is working — with
per-workspace notification rollups.

---

## 8. MVP path

1. **Spike (the risk):** Electron + React shell → one file tree + one CodeMirror/Shiki
   viewer + **one ghostty-web terminal pane.** Acceptance = terminal feels good, renders
   fast, UI never stalls.
2. **Tabs** — VSCode-style tabbed viewer.
3. **Git explorer** — history, diff, blame (off-thread engine).
4. **Notification + auto-title system** — §7.
5. **Workspaces** — multi-dir / worktree model + rollups.
6. **Polish** — markdown/HTML auto-render, themes, side-by-side panes.

*(v2 parking lot: harness viewer side tab — tokens, usage, skills, MCPs.)*

---

## 9. Open questions

- Native libghostty vs ghostty-web for v1 — decide after the spike.
- Git engine: JS (isomorphic-git, portable) vs native libgit2 binding (faster on big
  repos)? Lean native behind the off-thread boundary if history browsing feels slow.
- How much of the "minor edit" path do we actually need in v1 — save-in-place only, or
  also basic multi-file find/replace? Keep minimal.
- macOS vs Linux terminal-embed parity — track the embedded apprt Linux work.

---

## 10. References

- libghostty roadmap — https://mitchellh.com/writing/libghostty-is-coming
- awesome-libghostty (embed projects) — https://github.com/Uzaaft/awesome-libghostty
- Ghostling (embed example) — https://github.com/ghostty-org/ghostling
- Embedded apprt / Linux support discussion — https://github.com/ghostty-org/ghostty/discussions/11722
- parallel-code (prior art) — https://github.com/johannesjo/parallel-code
