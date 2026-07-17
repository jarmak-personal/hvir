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

#### Phase 8 addendum — 2026-07-15: transient terminal focus and file handoff

**The horizontal viewer/terminal divider owns a transient terminal-focus mode.** A small,
accessible double-up-chevron control expands the active terminal deck to the full center
height and hides the viewer surface; in that state it becomes a double-down-chevron that
restores the viewer and the exact prior terminal height. Expansion never overwrites the
workspace's persisted divider height, never unmounts viewer tabs or terminal panes, and
is not restored after app relaunch. `TerminalPane` receives the resulting resize through
its existing interface but knows nothing about application layout state.

Any intentional file activation restores the viewer before opening or selecting the
file: Files tree rows, Git Changes/History/graph entries, rendered internal links, and
terminal file links all share this rule. Terminal file links are added behind the
terminal seam as a user-activated raw link/path event. The renderer resolves relative
targets against the terminal's host-qualified workspace root, accepts absolute targets
only inside that same authorized workspace, and routes the resulting `HostPath` through
the existing viewer open path. Common `path:line[:column]` decorations may be parsed, but
path text is never executed and cannot expand filesystem authority. OSC 8 file links and
engine-supported plain-path detection remain implementation details of the active
`TerminalPane`.

**Why:** terminal-heavy work benefits from one-click vertical focus, while a file click
is an unambiguous request to see the viewer again. Keeping this as a reversible overlay
preserves the carefully chosen per-workspace split instead of making maximize/minimize a
second persistent layout system.

**Rejected:** persisting the maximized height as the workspace divider value; unmounting
the viewer or PTY while focused (loses scroll/state and creates recovery churn); teaching
the terminal engine about React layout; allowing terminal links outside the active
workspace; executing link text; requiring separate restore actions for file-tree, Git,
rendered-link, and terminal-link navigation.

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

#### Phase 5 addendum — 2026-07-12: remote Git worker routing

**Git parsing stays in the utility process; `ProjectHost` operations are brokered by
main.** The Git worker owns command construction and parsing, but its injected host is a
small proxy. `exec` and file reads travel over the worker port to main, where the host
registry dispatches them by host ID to the existing `LocalHost` or multiplexed
`SshHost`. Results return to the worker for parsing. The renderer continues to use the
same typed Git IPC on every host.

**Why:** SSH clients and auth/reconnect state are main-process resources. A second SSH
client in the Git worker would duplicate connections, prompts, trust state, caches, and
failure recovery; moving Git parsing into main would violate “nothing blocks the paint”
and ADR-005. The broker keeps both seams: expensive Git work is off-thread, while every
transport operation still crosses the owning `ProjectHost`.

**Rejected:** constructing `LocalHost` inside the worker (remote paths silently execute
locally and break ADR-010); creating a second `SshHost` per worker (duplicate transport
and auth lifecycle); running the whole Git engine in main (large log/diff parsing can
delay IPC and window lifecycle work); installing a remote helper (rejected by ADR-010).

#### Phase 5 addendum — 2026-07-13: repository topology is a viewer

**The all-ref commit graph is a project-scoped viewer tab; Rail History is its compact
current-branch navigator.** The rail uses the same deterministic SVG lane model at a
tighter scale. A commit click inserts fixed-height summary and changed-file tree rows;
selecting a file uses the existing historical-diff tab path. An explicit row action,
double-click, or Ctrl/Cmd+Enter opens the full graph anchored to that commit, while the
standing Open full graph action enters without a selection. The full surface keeps
fixed-height virtual commit rows, decorated branch/remote/tag refs, keyboard selection,
and a persistent right-side commit inspector. It begins at all refs and continues with
the existing opaque frontier cursor, so unmerged branches are visible without walking
the repository up front. Git discovery and parsing remain off-thread.

**Why:** VS Code's Source Control Graph proves the compact lane/table interaction and
opens selected changes in the editor. The rail is enough for quick topology and file
drill-down but still too cramped to be the only graph. Warp's Git dialog has a good
chevron-to-files disclosure pattern, but it is deliberately bounded to the commits
included in a push. Zed's current graph is the closest spatial precedent: a dedicated
workspace item with a virtualized graph table and a right-hand detail split whose changed
files can be a tree. hvir combines the compact navigator with that full workspace without
importing editor/write operations or either implementation.

The planned `commit-graph@2.4.0` spike passed MIT licensing, React 19 compatibility via
its `react >=18` peer range, dark-color customization, parent-based lanes, and infinite
loading. It failed the product fit: its built-in commit/detail DOM is not viewport-
virtualized, has no repository-browser keyboard model, and brings its own popup, tooltip,
icon, and infinite-scroll UI dependencies. `@tomplum/react-git-log@3.5.1` is React-19-
native and more composable, but its Canvas renderer is explicitly incomplete and its
paging is not row virtualization. A small local lane model and SVG painter therefore has
less policy and rendering surface while preserving the off-thread system-Git engine.

In the full viewer, commit selection changes the information architecture rather than
adding a narrow third column to the unchanged table. The metadata columns collapse, the
graph/subject list remains as the navigation context, and a visually joined detail surface
uses the released width for author/date/hash, the complete commit message, and changed
files. Commit bodies always pass through the existing off-thread, sanitized Markdown
renderer: plain text is already valid Markdown, so no format-sniffing heuristic is needed;
raw HTML remains disabled. The rail graph stays visible even while the full viewer is open
because it preserves project-level navigation when the user switches away from Git.

The Files tree decorates ignored entries lazily rather than folding Git work into
`readdir`. Each expanded directory paints from `ProjectHost.readdir` first, then sends its
immediate basenames through bounded, off-thread `git check-ignore` batches. Direct ignore
roots receive an explicit status label; their descendants inherit the muted treatment
without repeating it. Working-tree decorations reuse the single `GitChanges` snapshot
that drives the Git rail: file stems carry a restrained status tint and compact text
marker, while directories aggregate their changed descendants so collapsed branches
remain navigable. Expanded directories keep only the aggregate marker and let their
children carry the stronger color. Deleted descendants still contribute to their parent;
ignored paths do not. Non-repositories and decoration failures leave normal filesystem
browsing intact.

**Rejected:** making the narrow rail the only graph (topology loses the width needed for
merges and refs); variable-height commit bodies (inserted fixed-height virtual tree rows
preserve row/lane alignment); a generic force-directed graph (Git is an ordered DAG, not
an exploration network); keeping author/date/hash columns beside an open detail surface
(duplicates data while starving the detail); guessing whether a commit body is Markdown
(plain text already degrades correctly); scanning every ignored path repository-wide
(unbounded and unnecessary for a lazy tree); spawning Git once per visible row (remote
round-trip pressure); adopting either component despite the spike gaps; adding Git write
actions to the inspector (still outside the view-first v1 scope); adding a Files-tree
"show only changes" mode (the Git Changes view already owns that workflow; reconsider
only with broader v2 navigation evidence).

#### Phase 8 addendum — 2026-07-15: bounded branch navigation

**The active workspace may switch among existing repository-local branches
(`refs/heads/*`) from a branch selector in the Git rail.** This is navigation with a
filesystem consequence, not a general Git client surface. The selector always shows the
current branch or detached HEAD. A target is enabled only when the Git working tree is
clean, hvir has no unsaved viewer tabs in that workspace, and Git does not report the
branch checked out by another worktree. Selecting an enabled target runs the equivalent
of `git switch <branch>` without force or discard flags, then refreshes worktree
discovery, Files, Changes, History, and clean open tabs. The same flow works through
`ProjectHost` for local and SSH projects.

Branch enumeration and command construction stay in the Git utility process. The main
process grants a single-use, exact-root mutation authorization, matching the narrow
broker pattern used by stale worktree pruning; arguments never pass through a shell.
Failures leave the current workspace intact and surface beside the selector. Dirty,
occupied, or otherwise advanced cases point to the terminal instead of offering an
override.

**Why:** choosing which existing branch to inspect is a common viewer navigation action,
and requiring a terminal round trip for it makes the Git surface feel artificially
read-only. Clean-only switching preserves the view-first guardrail and avoids silently
carrying edits across branches. Keeping the control workspace-scoped also avoids
confusing branches with the project/worktree selector above it.

**Rejected:** creating, deleting, renaming, or tracking branches; checking out arbitrary
commits from the graph; force/discard/autostash controls; carrying staged, unstaged,
untracked, conflicted, or unsaved hvir edits across a switch; stage/commit/stash/merge/
rebase/push UI; placing the branch selector in the global project bar (branch state
belongs to one active worktree); invoking Git directly from the renderer or main process.

#### Phase 8 addendum — 2026-07-16: bounded remote synchronization

**The Git rail exposes cached upstream/base drift, explicit Fetch, and clean
fast-forward-only Pull.** Upstream status distinguishes incoming, outgoing, diverged,
and missing-upstream branches. Feature workspaces also show commits added to the default
branch since their merge base, even when their own remote branch is synchronized. A
configurable, conservative auto-fetch runs only while the Git rail is visible; explicit
Fetch remains available and failures stop automatic retries until the user retries.

Fetch and Pull retain the Git utility-process/`ProjectHost` path. Main grants one-shot
authorization for exact command grammars, arguments never cross a shell, and network Git
disables terminal/credential-manager prompting so a background control channel cannot
hang behind invisible input. Pull is offered only for an attached branch with a configured
upstream, a clean Git worktree, no unsaved hvir tabs, and a behind-only topology. It uses
`--no-rebase --ff-only`; any dirty, diverged, detached, missing-upstream, authentication,
or base-integration case is explained and handed to the agent in a terminal.

**Why:** upstream awareness is part of truthful Git viewing, and a safe fast-forward is
the routine completion of that observation. Requiring the user to remember an external
fetch makes hvir's status silently stale; requiring a terminal for an unambiguous
fast-forward adds ceremony without useful control. Complex integration still benefits
from an agent that can inspect and explain the repository.

**Rejected:** automatic pull; hidden merge/rebase strategy; autostash; conflict UI;
force, reset, push, upstream creation, or base-branch integration; retrying failed
background authentication; interactive credential prompts on buffered Git channels;
GitHub/GitLab-specific APIs; treating cached remote refs as freshly fetched.

### ADR-006 — Session recovery: harness resume, not a daemon
**Decision:** Recover agent sessions through the harness's own persistence
(`claude --resume`, `codex resume`), not by keeping PTYs alive in a daemon. An adapter
either pre-assigns the harness session UUID at launch or identifies exactly one persisted
session record in a bounded, fail-closed post-launch window. hvir never guesses from
ambient "latest" state or terminal text. Two seams keep this evolvable:
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

#### Phase 6 CLI verification — 2026-07-13

Claude Code 2.1.207 supports both deterministic launch (`claude --session-id <uuid>`)
and resume (`claude --resume <uuid>`). Codex CLI 0.144.3 accepts a known UUID or session
name through `codex resume <session>`, but exposes no launch option that lets hvir
pre-assign or directly capture that identifier.

For Codex, the adapter snapshots the existing rollout records immediately before launch,
then inspects only new `session_meta` records. It accepts an id only when exactly one
candidate has a matching working directory, `codex-tui` originator, session timestamp
within the launch window, and the same UUID in both the record payload and filename. A
short settle interval catches near-simultaneous candidates. The bounded discovery window
allows 90 seconds because Codex can delay creating the rollout until interactive startup
finishes; polling backs off to five seconds to limit local and SSH pressure. The PTY
supervisor serializes each pre-launch snapshot through PTY creation per host and adapter,
then releases the launch queue before the bounded identity scan completes. A later PTY is
never held behind the 90-second scan. If concurrent same-directory launches leave a scan
with multiple candidates, recovery fails closed as ambiguous instead of delaying a
terminal or choosing an id. The rail shows recovery as pending until one exact id is
known. If metadata is unavailable or changes shape, the terminal still launches but
recovery is visibly unavailable; hvir never chooses among candidates. Holding the launch
queue through the complete identity scan was rejected because an untouched first Codex
session could make every later Codex terminal appear blank for the full timeout.

An untouched Codex terminal may create no rollout during that window. The PTY supervisor
therefore retains the original pre-launch baseline and treats later user input as a
generic discovered-identity retry signal. It does not parse prompts, messages, or terminal
text: the first input after an unavailable attempt merely starts another bounded adapter
scan. Exactly one match enables resume; ambiguity remains terminal for that launch.

The rollout layout is an internal, version-sensitive Codex detail and remains contained
inside `CodexAdapter`. `codex resume --last` remains explicitly rejected because it is
global ambient state. Launching Codex, immediately exiting it, and relaunching with the
printed resume id is also rejected: it visibly churns the terminal, can interrupt startup
state, and provides no stronger identity guarantee than matching the persisted record.

#### Phase 6 addendum — 2026-07-13: context pressure is operational state

**The terminal rail may show current context pressure, but not the broader v2 harness
telemetry viewer.** Context exhaustion directly determines when a user should compact or
start a fresh terminal, so the product owner pulled this one signal into Phase 6. A narrow
adapter-owned observer reports current used tokens and, when authoritative, the model
window and percentage; the PTY supervisor owns its lifecycle and forwards typed snapshots
to the renderer. Exact percentages use a stable meter: neutral below 40%, amber from
40–69%, and red at 70% or above. A trustworthy count without a window renders as a neutral
compact token count. Missing trustworthy data renders as `--`; plain shells have no meter.

Codex observation reuses the exact rollout record established by session discovery. A
host-side filtered follower sends only structured `event_msg` / `token_count` records
through `ProjectHost`, with bounded line buffering and PTY-owned cleanup. The percentage
uses `last_token_usage.total_tokens / model_context_window` (falling back to current
input tokens for older records); cumulative
`total_token_usage` is deliberately rejected because it spans the conversation rather
than the current context. Compaction therefore lowers the meter naturally.

Claude Code observation follows the transcript for its exact preassigned session id. The
latest main-thread assistant usage supplies current input, cache-creation, cache-read, and
output counts; hvir shows their sum as a neutral compact count because the transcript does
not expose an authoritative window. Claude's official status-line input does expose the
percentage, but installing a tap would replace or wrap user configuration and can alter
the terminal surface, especially on SSH hosts. Terminal-screen scraping and
model-name-to-window lookup tables are rejected as configurable and version-fragile.
Broader cost, skills, MCP, and usage telemetry remains parked for v2.

#### Phase 6 addendum — 2026-07-13: persisted recovery registry

**Recovery is an exact, local registry of harness conversations, not a record of live
PTYs.** After the supervisor confirms a harness spawn, hvir records the adapter id,
exact harness session id when known, host-qualified project root and cwd, last title,
rail position, and active state in app metadata. Plain-shell records omit the harness id
and restore a new shell in the same pane; they do not claim to preserve shell process
state. A discovered-id harness may remain provisional when the harness creates no durable
session before teardown. hvir retains that pane and relaunches the adapter fresh, but it
never treats the provisional record as resumable. Explicitly closing a terminal forgets
its record; quitting hvir, reloading the renderer, switching projects, or disconnecting
a host retains it.

When a project surface starts, registered sessions are offered in one restore prompt,
selected by default and restored to their prior rail order. A visible setting permits
automatic restore, but the default remains prompt. Plain shells and provisional harness
records launch fresh; every harness resume request is authorized in main against the
stored terminal id, adapter, harness id, project root, and cwd before the adapter command
is spawned. A connected terminal also uses that exact identity after a host reconnect.
Missing, ambiguous, mismatched, or provisional identity fails closed and never falls
back to ambient “last session” state.

The registry file is local even for SSH projects; its project and cwd values remain
host-qualified, and all reads and writes go through the local `ProjectHost`. It stores no
terminal output, prompts, credentials, or harness transcript contents. Renderer-local
layout updates can change only the presentation fields of an already authorized record.

**Rejected:** persisting PTYs or scrollback (the harness transcript is the durable state);
auto-restore by default (surprising process launch on app open); implying a recreated
plain shell preserves process state; accepting a title/cwd match without an exact id (can
resume the wrong conversation); deleting records during ordinary app or network teardown
(defeats recovery); storing the registry on each remote host (unnecessary remote state
and weaker ownership).

### ADR-007 — Per-tab view mode: rendered / source / diff
**Decision:** Every viewer tab has a single three-state **view mode** — *rendered /
source / diff* — with a visible segmented control and one keybinding that cycles it.
The **default** is inferred: markdown, mermaid, and HTML open rendered ("this is an md,
render it" — never a "preview" verb, never leaving hvir); a file opened from the git
panel opens in diff mode, except an untracked file with no meaningful base opens rendered
or source by the normal file-type rule; from the file tree, source (or rendered). But the
mode is always one keystroke away, always visible, and sticky per tab. Diff mode gets its
own small **base selector**: working tree vs HEAD vs branch-point — branch-point being the
"what did the agent do on this worktree" view.
**Why:** This is what "renders beautifully" actually means: *the right renderer,
automatically, with zero friction* — not visual noise. And it unifies rendering with
file⇄diff swapping into one model. Defaults are smart; controls are always exposed —
the system must never feel smarter than the user.
**Rejected:** separate preview commands/panes (VSCode's `Ctrl+Shift+V` friction); fully
automatic mode switching with no visible, overridable control.

#### Phase 3 addendum — 2026-07-12: preview security and diff semantics

**HTML previews use a dedicated `hvir-preview:` protocol.** The protocol returns each
document with a restrictive CSP response header, and the iframe has `sandbox="allow-scripts"`
without `allow-same-origin`, navigation, popup, or form capabilities. The workbench CSP
only permits the scheme as a frame source; it does not share a script nonce or relax its
own `script-src`. Preview creation/release is typed IPC restricted to the workbench's main
frame, and protocol documents are random-id, bounded, in-memory responses.

**Why:** `srcdoc` inherits the embedding document's CSP. Letting arbitrary preview scripts
run there required either weakening the workbench CSP or coupling both documents through a
nonce; a static nonce provides no XSS defense, while meta-CSP injection can occur after
attacker-controlled leading markup. A response header applies before any document bytes are
parsed and keeps preview policy independent from workbench policy.

**Rejected:** a static shared nonce (guessable, weakens workbench defense-in-depth); a
runtime parent/child nonce (cross-document policy coupling and window lifecycle complexity);
`file:` URLs (excess filesystem privilege and bypasses `ProjectHost`); meta-only CSP
(ordering depends on hostile document markup).

**Working-tree diff semantics:** the selector's working-tree view compares the git index
(`git show :path`) on the left with the live working file on the right. The UI labels the
left side **Index**. Comparing the working file with itself was rejected because it is a
no-op; index → working tree is the useful unstaged-change interpretation of this selector.

**Mode keybinding:** `Ctrl/Cmd+Shift+M` cycles modes. Events originating in the terminal
pane are ignored so Linux terminal paste (`Ctrl+Shift+V`) and terminal input remain intact.

**Branch-point diff semantics:** the branch-point Changes group and the diff it opens both
compare merge-base to `HEAD`. Uncommitted work remains in the working-tree group and in the
HEAD/Index selectors; it is intentionally excluded from the branch-point diff so its badge
and opened content answer the same “what was committed on this branch?” question.

### ADR-008 — Workspaces: project → worktree tiers
**Decision:** A two-tier model. The **project** (the main repo) is the *registration*
unit — the thing you add to hvir. **Worktrees** are *discovered* children
(`git worktree list`), each one a workspace. The workspace tier remains visible even when
there is only the registered project root, giving branch/workspace context one stable
home. A plain non-git directory is a degenerate single-workspace project, so the model has
no special cases.
**Why:** The project boundary is the one harnesses care about (CLAUDE.md, config, trust
are project-scoped). It gives notifications a natural rollup path (terminal → worktree →
project), and a persistent workspace tier keeps the hierarchy from changing shape when a
second worktree appears. Because worktrees are *discovered, never managed*, hvir stays out
of worktree lifecycle entirely — protecting the "not an orchestrator" non-goal (§2). New
agent workspaces simply appear.
**Rejected:** flat workspace-per-directory (loses the project boundary); hvir-managed
worktree creation/cleanup (one step from branch naming and merge-back — orchestration
creep); collapsing the workspace tier when trivial (hides branch context and makes the
hierarchy move when worktrees appear); a separate local/remote host strip above the left
rail (duplicates project-tab identity and wastes vertical space). SSH connection controls
live behind the active project's connection badge; local projects need no host chrome.

#### Phase 7 addendum — 2026-07-14: persisted discovery and multi-root Git authority

**The local project registry is the durable authority list; the active workspace remains
the renderer's filesystem authority.** Registration persists the host-qualified project
root, display name, active workspace, and last discovered worktree records in local app
metadata. Worktrees are reconciled from NUL-delimited `git worktree list --porcelain -z`
output in the Git utility process. A missing worktree is retained as a gray workspace,
including its layout/session identity, until the user explicitly dismisses it. Plain
directories produce the same one-workspace model with Git surfaces omitted.

Phase 5's Git broker confinement expands from the one active root to the exact set of
registered project and discovered workspace roots so the utility process can refresh
inactive-project discovery and changed-file counts. This does not expand renderer file
access: filesystem/viewer IPC still resolves only against the active workspace. Main
chooses the deepest registered boundary for each worker host call, and the existing
command grammar, canonical-path checks, output bounds, and timeouts still apply. A cheap
worktree/status refresh runs after watch events, on demand, and on a five-second fallback
poll; parsing and Git execution remain off-renderer.

Workspace switches preserve live terminal components and PTYs while swapping the active
filesystem authority. Tabs and pane sizes persist per host-qualified workspace, and clean
tabs refresh asynchronously when revisited; dirty drafts remain authoritative. Removed
workspace dismissal is the explicit point that ends its PTYs and forgets recovery
records.

Project tabs may be explicitly closed when another registered project can become active.
Closing unregisters the project and unmounts its live PTYs without touching its files,
Git branches, or worktrees. Terminal recovery metadata is retained so re-registering the
same host-qualified root can restore those sessions. V1 keeps one project registered at
all times: a zero-project welcome state was rejected because it would make filesystem,
Git, watch, and PTY authority optional throughout the application for little workflow
gain; register a replacement before closing the final project.

**Rejected:** one Git worker or SSH connection per workspace (duplicates transport and
auth state); granting inactive roots to general renderer filesystem IPC (weakens the
active-workspace boundary); killing PTYs on workspace switches (turns navigation into
session loss); treating object identity as path identity across IPC (structured cloning
would restart stable workspaces); watching every inactive tree recursively (unbounded
watcher and SSH load).

#### Phase 7 addendum — 2026-07-14: explicit stale-record pruning

**hvir may prune Git worktree records only after Git itself reports them as
`prunable`.** This is a narrow cleanup exception to ADR-008's discovered-never-managed
rule, explicitly approved by the product owner after real SSH use surfaced detached
benchmark records whose worktree `.git` locations no longer existed. It does not permit
creating, moving, removing, or repairing a live worktree.

The worktree tier preserves Git's porcelain reason and last known HEAD, marks the entry
as prunable, and offers one project-level **Prune N** action. The action lists every
host-qualified path, reason, and abbreviated HEAD and warns that an otherwise-unreferenced
detached commit may later be garbage-collected. Confirmation invokes
`git worktree prune --expire now --verbose`; Git's command is project-wide, so the UI does
not pretend it can target one stale row. The Git utility process issues the command
through `ProjectHost`, and main grants the broker a single-use mutation capability for
that exact host-qualified project root. Afterward hvir rediscovers the worktrees and
forgets recovery/layout state only for confirmed records Git no longer reports.

**Why:** stale worktree metadata is surfaced by hvir in the workspace tier, and leaving
cleanup to an external terminal makes that surface an unactionable warning. Git's prune
operation removes administrative records rather than working directories, while the
prunable precondition, explicit bulk confirmation, and single-use broker authorization
keep the exception materially narrower than worktree orchestration.

**Rejected:** automatic pruning during discovery (surprising mutation, especially for
temporarily unavailable storage); labeling the existing local-only dismiss control as
prune (the Git record would simply reappear); deleting `$GIT_DIR/worktrees` entries
directly (reimplements Git and is unsafe); `git worktree remove` (acts on a worktree,
not the already-stale administrative record).

#### Phase 8 addendum — 2026-07-15: one workspace selector

**Workspace navigation lives only in the top project/worktree tier.** The right terminal
rail lists terminals from the active workspace and contains no duplicate rows that jump
to inactive worktrees. Inactive PTYs remain live and continue contributing attention
rollups to their workspace and project controls at the top.

**Why:** worktree rows in the terminal rail repeat the global workspace selector, mix two
navigation hierarchies, and spend scarce rail space on something that is not a terminal.

**Rejected:** keeping inactive-workspace jump rows for convenience; flattening terminals
from every workspace into one list (loses cwd and recovery ownership); removing top-level
attention rollups when the duplicate rows disappear.

#### Phase 8 addendum — 2026-07-16: project scope is explicit and demand-driven

**First-run registration is explicit; an open project's filesystem activity follows
visible demand.** A bare launch restores the last registered project when one exists. If
there is no history and no explicit launcher/CLI path, hvir uses the native local folder
picker and exits cleanly on cancellation. An explicit path takes precedence over history.
This is a bootstrap step, not a zero-project workbench: after selection ADR-008's stable
project → workspace model remains unchanged.

Every directory is still a valid project. The root receives one shallow watch so its
immediate tree and a newly created `.git` entry stay current. Expanded directories and
parents of open viewer files contribute bounded, host-qualified shallow interests; an
interest disappears when it is no longer visible or open. Main validates canonical
confinement and coalesces the current set into one content-watch backend, preserving SSH
channel capacity. Repository metadata has its own shallow watch. The renderer's file tree
continues to load directory contents lazily through `ProjectHost`; neither local native
watch fallback nor SSH polling may recursively scan an unexpanded tree.

Repository discovery gates Git behavior. A known plain directory mounts no Git rail,
runs no ignored-entry classification, and is omitted from periodic Git status/worktree
polling; initial/manual discovery and a root `.git` event can enable those capabilities.
For repositories, the detailed working-tree snapshot is capped. Crossing the cap remains
a truthful dirty state, is disclosed in the Git rail, withholds incomplete per-path Files
decorations, and skips per-file statistics and branch-point detail whose cost scales with
the complete change set. The `ProjectHost` buffered-exec boundary terminates status after
a bounded NUL-record count (allowing for porcelain rename pairs) or byte ceiling and
returns only the bounded prefix. All Git execution and parsing remain off the render
thread under ADR-005.

**Why:** laziness in the visible tree is not sufficient if a background watcher or status
loop independently traverses a user's home directory. Making project registration
intentional prevents the most surprising case; demand-driven shallow interests make even
an intentional broad directory safe and preserve the useful file-explorer/terminal
experience for non-repositories. A bounded Git model keeps the same responsive failure
posture when the project really is a very dirty repository.

**Rejected:** silently using `process.cwd()` on first launch (shell home is usually
context, not intent); forbidding home or non-Git roots (breaks the useful degenerate
project); recursively watching every open project (unbounded descriptors, scans, and SSH
work); one SSH watcher/channel per expanded row (capacity grows with UI state); hiding
the symptom with a longer startup spinner (paint still waits); assuming `ignoreInitial`
prevents Chokidar traversal (it suppresses events, not discovery); running periodic Git
probes forever on known plain directories; returning an unbounded change model.

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

#### Phase 6 addendum — 2026-07-13: quiet OS attention

The OS badge is a quiet aggregate of distinct terminals with actionable **idle** or
**bell** dots. New-output-only dots remain visible in hvir but do not raise the OS count.
The badge appears only while every hvir window is unfocused; focusing any hvir window
clears the OS badge without clearing terminal dots, whose existing focus-the-terminal
rule remains authoritative. macOS uses the Dock count and Linux uses Electron's Unity
launcher count where available. Unsupported Linux desktops fail silently.

**Rejected:** sound, toast notifications, Dock bouncing, window flashing, or Linux
urgency fallbacks (too noisy for normal streaming work); counting raw output (nearly
permanent badges); clearing terminal dots on app focus (loses which terminal raised the
signal); per-event badge increments (duplicates one terminal instead of aggregating it).

#### Phase 8 addendum — 2026-07-15: distinct status and attention language

The focus-clears/parents-aggregate behavior and signal priority remain unchanged, but
connection state, Git changes, and terminal attention no longer share ambiguous dot/badge
styling. Project connection state uses a labeled status glyph or pill at the leading edge.
Attention uses one consistent trailing badge vocabulary: a terminal shows its strongest
unseen signal, while workspace and project parents show the count of unseen child
terminals. Changed-file counts retain a separate Git-specific treatment. Color is
secondary to shape, placement, label, and accessible text.

Phase 8 re-verifies the complete event path with real and synthetic plain BEL/OSC bell,
output, idle-after-burst, terminal focus, workspace/project switching, window focus, and
OS badge behavior. A bell transport or focus-tracking failure is a functional bug, not a
theme-polish issue.

**Rejected:** identical dots on both sides of a tab; color-only signal distinctions;
using the connection indicator as an attention carrier; clearing child attention by
focusing only its parent; replacing the quiet Dock/launcher count with sound or toasts.

#### Phase 8 addendum — 2026-07-15: turn-qualified idle attention

Idle-after-burst is armed by a user submission boundary (Enter/newline through the
`TerminalPane` input event), then raised at most once when that turn first becomes quiet.
PTY startup, recovery prompts, resize repaints, and later periodic control-sequence output
do not repeatedly manufacture **Ready** attention. Bytes arriving after a settled turn
can still raise the lower-priority **New output** signal; another user submission re-arms
**Ready**. This rule is terminal- and harness-independent. Terminal selector controls
carry their session identity so selecting one remains terminal focus across an app-window
refocus and consistently clears its child attention.

**Rejected:** treating every PTY write as a fresh turn (quiet shells and idle harness
repaints repeatedly become Ready); parsing harness screen contents; per-harness timing or
prompt heuristics.

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

#### Phase 4/5 addendum — 2026-07-12: project authority and the Git broker

**Opening a folder establishes a new authority boundary; it is not itself a renderer
security boundary.** The renderer drives the explicit host/folder picker and main verifies
that the requested host exists and the selected path is an absolute, accessible directory.
Once opened, that canonical directory becomes the registered root and every subsequent
filesystem, PTY, watch, and Git request is confined beneath it. A compromised renderer
could ask to open another readable directory on an already configured host; root
confinement protects against accidental and content-driven escapes, not against that
deliberate re-registration.

**Why:** local and remote selection share one `ProjectHost` flow, and remote roots cannot
use an OS directory capability. Treating the picker gesture as a durable security token
would require a separate main-owned chooser/authorization protocol for both local and SSH
hosts. That is not part of the current Electron threat model, which already trusts the
workbench renderer to request reads and minor saves. Revisit if untrusted renderer content
ever gains same-origin execution; the preview protocol deliberately prevents that today.

**The Git utility process is untrusted at its main-side broker.** Main independently pins
host calls to the active project's host and canonical root, permits only `git -C` execution
and confined text reads, bounds arguments/output, and times out calls. Worker-side checks
remain useful validation but are not the enforcement boundary.

**Rejected:** accepting arbitrary worker commands/cwds because the worker already validates
them (puts the trust check on the hostile-repository parsing side); treating any host ID in
the registry as active authority (lets a stale worker reach replaced sessions); claiming
the renderer-selected root is a capability without a main-owned gesture token.

#### Phase 7.5 addendum — 2026-07-14: one logical SSH host, pooled transports

**`SshHost` remains one logical `ProjectHost`, but may own a bounded role-aware pool of
physical SSH transports.** The host id, trust decision, authentication coordinator,
connection state, SFTP/cache state, and reconnect contract remain singular. Control
transports carry bounded `exec`, SFTP, watchers, and adapter telemetry hubs with reserved
capacity; terminal transports carry PTYs only. A PTY is pinned to one transport for its
lifetime. Pool admission opens lazily, reuses idle capacity first, serializes new
authentication, and spills after a channel-open refusal without moving existing PTYs.
The initial policy caps one host at eight physical transports (at most two control), with
soft budgets of six control channels or eight PTYs per transport and a five-minute idle
grace for auxiliaries. These are centralized safety defaults, not claims about a server's
configured `MaxSessions`; real-host evidence may revise them. Buffered control execs admit
four concurrent operations by default, still within transport reservation rather than a
separate global serialization bottleneck. A channel-open refusal excludes that transport
only for the bounded admission attempt; it records diagnostics but never permanently
shrinks a live transport's soft budget, so later work can recover when server capacity does.
Some SSH servers close an exec channel without the optional SSH `exit-status` message.
Buffered execs therefore wrap only their bounded command in a POSIX subshell that appends
an unguessable per-command status marker to stderr; hvir strips it before returning the
result and uses it only when the transport status is absent. Streaming services and PTYs
retain their native lifecycle and never receive this wrapper.

**Context telemetry is multiplexed per `(host, HarnessAdapter)`, not followed once per
terminal.** Codex and Claude Code each own one lazy host-scoped hub that reconciles a
versioned full subscription set over a bounded duplex `ProjectHost.execStream`. Adapter
code still owns transcript/rollout discovery, remote filtering, framing, and parsing. Hub
epochs and per-subscription admitted-generation floors reject late or cross-session records
without dropping replay that overlaps a newer full-set reconcile; the PTY supervisor still
owns subscription lifecycle and the latest typed snapshot. Concurrent followers serialize
bounded frames through an owned, self-healing, bounded-wait lock whose teardown is shared by
all adapters. A hub is a temporary child of its SSH channel, never installed remote software.

**Why:** a normal agent workload can keep 10+ terminals across projects on one machine.
OpenSSH commonly limits shell/exec/subsystem channels per connection; PTYs, SFTP,
watchers, Git commands, and one follower per terminal otherwise compete for that same
budget. Merely serializing Git preserves a slot at small scale but cannot make ten PTYs
fit beside the control plane. Pooling solves physical capacity without weakening the
logical host seam, while telemetry hubs remove avoidable one-channel-per-agent pressure.
Interactive Git or long-running user commands remain inside a PTY; hvir's own `exec` is
bounded noninteractive control work and never spills onto terminal transports.

**Authentication and failure contract:** reusable password/passphrase material may live
only in memory until explicit disconnect/app quit; keyboard-interactive/OTP answers are
never cached. Pool growth has one prompt sequence per logical host, finite method/challenge
attempts, and no prompted automatic retry after failure or cancellation. Failure of an
auxiliary transport exits only its pinned PTYs exactly once and does not mark the control
plane disconnected. Harness resume remains recovery; pooling does not claim process
survival across a broken transport. The prompted-growth block lasts until explicit disposal
or a later successful primary authentication; that lifecycle boundary permits promptless
growth with newly reusable in-memory credentials without reintroducing modal retry loops.

**Rejected:** requiring users to raise `MaxSessions` (not portable or always permitted);
one `SshHost` per project/workspace/worker (duplicates identity and lifecycle); one TCP
connection per PTY (unbounded transport/auth churn); letting control commands borrow PTY
transports (destroys reservation); terminal-screen scraping or OSC injection for telemetry
(fragile and contaminates the terminal surface); restarting every telemetry follower on
ordinary subscription churn (avoidable gaps/work); and a persistent installed remote
agent (still rejected by ADR-010).

### ADR-011 — Distribution: one npm launcher, native payloads

**Decision:** hvir has one supported installation contract: `npm install -g hvir-workbench`,
then `hvir`. The public launcher selects an integrity-checked optional payload package for
Linux x64, Linux arm64, or macOS arm64. Payloads contain an electron-builder unpacked app
built and smoke-tested on the matching native architecture; their npm install step expands
the app without compiling on the user's machine. Intel macOS, Windows, dmg, zip, AppImage,
and deb are not release targets.

**Why:** hvir's likely users already have Node/npm for their agent harnesses, and a single
install/update/remove path is materially easier to explain and support. The launcher keeps
the user-facing package small while npm handles platform selection, version matching,
integrity, caching, and provenance. Native runners keep Electron and `node-pty` honest;
Linux arm64 adds little policy complexity now that both Electron binaries and hosted arm64
runners exist. The three hidden payload packages are release mechanics, not alternative
products.

**Rejected:** maintaining native installers alongside npm (multiple install, update, and
support paths); publishing the source app and compiling Electron/native dependencies on
user machines (slow and toolchain-sensitive); one universal package containing every
platform (wasted bandwidth); a postinstall download from a separate release host (splits
version/integrity authority between npm and another service); macOS x64 (explicitly outside
the supported hardware target).

### ADR-012 — Harness providers and launch profiles, not an extension host

**Decision:** After v1, evolve `HarnessAdapter` into a main-owned **harness provider
registry**. A provider is a trusted, bundled module that owns one harness's executable
conventions, launch/resume composition, exact-session strategy, title normalization,
runtime capability probe, and optional structured observers. This evolves the existing
ADR-006 seam rather than adding a parallel launch path: every interactive process still
flows through the PTY supervisor and `ProjectHost`, and `TerminalPane` remains unaware of
which harness produced the bytes.

The renderer receives a serializable provider catalog from main and treats provider IDs as
opaque, bounded strings. Labels, availability, effective capabilities, and configured
launch choices come from that catalog; shared IPC, React, and persisted-session parsing do
not enumerate known providers. Persisted records for a provider that is temporarily missing
or removed remain visible as unavailable records instead of being discarded, but cannot
resume until the exact provider and session identity are available again.

Provider support is capability-based, not boolean. The common capability vocabulary covers:

- interactive launch;
- session identity (`none`, `preassigned`, or fail-closed post-launch discovery) and exact
  resume;
- title normalization;
- structured telemetry facets; and
- provider/version compatibility on one host.

Each provider performs a bounded asynchronous probe through `ProjectHost`, cached per
`(host, provider, profile ID, launch revision)` and invalidated by connection or
launch-configuration changes. Cached results also expire: available results after ten
minutes and missing, incompatible, or failed results after two minutes. Opening the launch
menu re-probes stale entries in the background; a provider-classified executable/version
launch failure invalidates the entry immediately. Different local and SSH hosts may
legitimately expose different executable versions and capabilities. Probes may inspect
provider-owned `--version`, help, or machine-readable surfaces, but there is no global
parser that guesses semantics from arbitrary help text. Probe latency changes menu
freshness, never first paint or terminal availability.

**Launch profiles are configuration layered over providers.** hvir ships immutable default
profiles for the plain shell and each bundled provider. Users may add global or
project-scoped profiles such as `Claude Code — bypass permissions`, `Codex — monorepo`, or
`My agent`. A profile contains a stable ID and a monotonic **launch revision** covering only
launch-relevant identity: provider ID and launch-contract version, scope, executable, argv,
environment/path bindings, and derived risk. It increments only when that normalized
identity changes, including a bundled provider contract/risk-rule upgrade. Cosmetic
metadata—display name, description, and menu order—is stored separately, with an independent
metadata revision if concurrency requires one, and never invalidates recovery or risk
acknowledgment. Project/workspace placeholders resolve only through a fixed vocabulary;
every stored path is a `HostPath`, and arbitrary `$variable` or shell interpolation is not
supported. A named binding outside the registered project requires an explicit main-owned
folder-selection gesture on that host.
It grants that path only to the composed harness invocation; it does not expand the
renderer's normal active-workspace filesystem authority. If a global profile is evaluated
without the active project/workspace required by one of its tokens, it remains listed as
unavailable with that reason and launch is rejected before PTY creation.

Main owns profile persistence, validation, command composition, and value-aware command
preview. Arguments always remain an argv array and environment changes remain structured
set/reference/unset operations. Profiles never supply an opaque shell command. The provider
owns session-selection arguments and their position, so user arguments cannot accidentally
replace `--session-id`, `--resume`, `resume <id>`, or another provider invariant while hvir
still claims exact recovery. Provider defaults are overlaid by profile environment changes,
then hvir's protected `TERM`, `COLORTERM`, and `TERM_PROGRAM` values win. Executable lookup
may use the host's interactive shell environment as it does today, but the shell only
resolves the already-quoted executable and argv before `exec`; it does not evaluate user
command text.

A built-in **custom command provider** is the escape hatch for a fast-moving ecosystem. It
can launch any explicitly configured executable, argv, and non-secret environment values
through the same supervisor/host path, but advertises no session recovery or structured
telemetry unless a real provider later adopts that command. hvir therefore never blocks a
new harness on a release, while “first-class” continues to mean exact identity plus
trustworthy capabilities rather than a logo in a menu.

Environment values stored directly in a profile are visibly treated as plaintext
non-secrets. Secret values are reference-only (for example, an explicitly selected process
environment name or future OS credential handle); they are never copied into renderer
storage, command previews, logs, or the terminal recovery registry. Preview displays
non-secret literals as entered and redacts only reference-sourced secret values; “redacted”
does not imply that stored literals are encrypted or protected. Remote forwarding is
explicit because a local environment value and a target-host environment value are not the
same authority. An explicit unset removes an inherited variable before the harness's
interactive shell starts, subject to that shell's own startup files setting it again.

The terminal recovery registry stores provider ID, profile ID, and launch revision beside
the existing exact harness identity and host-qualified cwd/project. Fresh launches, resume,
reconnect, and restart use the same launch revision. A missing provider/profile or changed
launch revision blocks automatic restoration and asks the user to review/rebind it; cosmetic
edits do not. Rebinding is permitted only to another profile of the same provider because an
exact harness session ID has no meaning across providers. hvir does not silently resume with
changed flags or permissions.

Providers classify resolved launch configuration as `standard`, `elevated`, or
`unclassified` using a provider-owned exact rule set. Rules cover known aliases,
`--flag=value` forms, environment keys, and embedded config overrides such as `-c
key=value`; classification is a best-effort warning, not a security boundary. A Custom
profile and any extra token a provider cannot classify are never assumed standard.
Elevated and unclassified profiles are visibly marked and may auto-restore only after an
explicit acknowledgment tied to the launch revision.

Providers also declare the executable, environment/config keys, and path bindings that can
change their session-artifact location. Main derives a bounded **artifact identity** from
only those resolved inputs and supplies it to discovery and telemetry. Artifact-relevant
changes reconcile the subscription; cosmetic or artifact-irrelevant launch changes do not
restart the shared `(host, provider)` hub. A bundled provider that offers discovery or
telemetry cannot register a reserved environment key without also declaring its artifact
semantics; profile validation therefore fails closed before a possibly wrong artifact tree
can be observed. Future provider contracts that accept opaque config namespaces must retain
the same fail-closed behavior and surface a validation warning for keys they cannot classify.

**Harness-tab data uses optional, provenance-bearing facets.** The normalized snapshot has a
version, observation time, source, freshness, and optional facets for session, model, context
pressure, usage/cost, turn/approval state, and loaded capabilities such as skills or MCP
servers. Providers may also expose bounded namespaced data that has no honest common
meaning. Unsupported, unavailable, and stale are distinct states. Existing generic terminal
signals (input boundary, output, idle, bell, title, exit) remain provider-independent and are
never inferred from a provider facet. Structured observers remain provider-owned,
off-renderer, and multiplexed per `(host, provider)` where practical, preserving the Phase
7.5 channel model. Terminal-screen scraping remains rejected.

This registry is **plugin-shaped internally but is not a public plugin platform**. New
first-class providers are reviewed and bundled with hvir. No arbitrary JavaScript/native
module loading, provider-contributed renderer UI, marketplace, install lifecycle, or remote
helper is introduced. A future declarative provider package or out-of-process provider SDK
requires its own ADR after the internal contract has real evidence from multiple harnesses.

**Why:** the existing adapter already proves the hard seams—exact recovery, local/SSH
composition, and adapter-owned telemetry—but its closed ID unions, duplicated renderer
labels, and hard-coded persistence parser make even launch-only additions cross-cutting.
Separating provider behavior from user launch policy lets hvir keep pace with new CLIs and
one-off flags without weakening deterministic recovery. Capability negotiation reflects the
real world: harness versions differ between hosts, and launch, resume, context, cost, and
skills/MCP visibility evolve independently. The generic provider preserves immediate access;
trusted providers add depth incrementally.

**Rejected:** keeping a closed built-in adapter union (every harness addition leaks across
IPC, UI, and persistence); treating a raw command line as the profile format (quoting,
injection, remote composition, and resume-flag ambiguity); appending user args blindly after
provider args (subcommand CLIs require provider-owned placement); falling back to ambient
`latest` session state (can resume the wrong conversation); parsing TUI contents for session
or telemetry state (fragile and contaminates the terminal seam); making every provider fit
one lowest-common-denominator telemetry object (hides useful truthful differences); loading
third-party code in main or renderer (an extension host by another name); and making hvir an
ACP/RPC agent frontend instead of continuing to host the user's native terminal harness.

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

**Spike result:** accepted 2026-07-12; `ghostty-web` is the v1 engine. See the ADR-003
Phase 2 addendum for evidence and retained caveats.

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
  directly. Interacts with ADR-006 resume. **Phase 4 probe (2026-07-12):** neither tool
  is installed on the development host, and requiring either would add a remote package
  dependency to the otherwise agentless design. Do not install or silently require one;
  defer an opt-in prototype until a real SSH drop test can compare it with harness
  resume.
- Remote watch strategy per host — polling vs `inotifywait` stream; capability-detect
  at connect time?

---

## 10. References

- libghostty roadmap — https://mitchellh.com/writing/libghostty-is-coming
- awesome-libghostty (embed projects) — https://github.com/Uzaaft/awesome-libghostty
- Ghostling (embed example) — https://github.com/ghostty-org/ghostling
- Embedded apprt / Linux support discussion — https://github.com/ghostty-org/ghostty/discussions/11722
- parallel-code (prior art) — https://github.com/johannesjo/parallel-code
