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

### Read-first constraints

Read these repository-wide constraints before selecting feature-specific decisions:

- [ADR-001](adr/ADR-001-electron-shell.md): the Electron process and responsiveness boundary
  governs where every capability may perform expensive work.
- [ADR-010](adr/ADR-010-project-host-remote-boundary.md): host-qualified paths and `ProjectHost`
  authority govern project operations across local and SSH features.
- [ADR-014](adr/ADR-014-modular-monolith-ownership.md): capability ownership, inward dependencies,
  explicit resource lifetimes, and test altitude govern changes across the repository. Its budget
  paragraph has scoped replacements below; the other constraints remain active.
- [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md): source coverage, budget
  provenance, and runtime/type dependency rules govern all maintained source and normal verification.

Then read the decisions governing the feature and its public seams, such as terminal panes,
providers, Git, viewers, workspaces, or installation. Reading priority is separate from lifecycle:
an active feature decision is still binding in its scope, while a read-first record can be active
only in part. The notices below mirror each record's canonical lifecycle. **Partially superseded**
preserves every unaffected rule; **Superseded** preserves history only. Follow replacement chains
with their stated scopes, rather than treating a partial successor as retirement of a whole record.

### [ADR-001 — Electron as the shell](adr/ADR-001-electron-shell.md)

> Lifecycle: Active

Electron provides the cross-platform desktop shell; responsiveness comes from keeping heavy
work off the render thread.

### [ADR-002 — React on electron-vite for the render layer](adr/ADR-002-react-electron-vite.md)

> Lifecycle: Active

React and electron-vite provide the render/build layer while feature models and expensive
work stay outside the renderer root.

### [ADR-003 — Terminal is a swappable pane, not the foundation](adr/ADR-003-swappable-terminal-pane.md)

> Lifecycle: Active

`TerminalPane` isolates engine choice, terminal-focused layout, and typed file-link
activation from the rest of the workbench.

### [ADR-004 — Code viewer: CodeMirror 6 + Shiki](adr/ADR-004-codemirror-shiki-viewer.md)

> Lifecycle: Active

CodeMirror supplies the read-first surface and Shiki supplies TextMate/VS Code-quality
highlighting without turning hvir into an IDE.

### [ADR-005 — Git engine: shell out to system git](adr/ADR-005-system-git-engine.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-021](adr/ADR-021-system-git-dirty-navigation-safety.md) | partial | Clean-worktree navigation prerequisite and handing every dirty branch switch or pull to the terminal.

System Git runs behind an off-thread engine and a main-owned `ProjectHost` broker; the few
mutations hvir exposes are exact, bounded navigation operations.

### [ADR-006 — Session recovery: harness resume, not a daemon](adr/ADR-006-exact-harness-recovery.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-020](adr/ADR-020-two-explicit-recovery-skips-forget-record.md) | partial | Indefinite recovery-record retention until explicit close.
> Superseded by: [ADR-031](adr/ADR-031-transparent-provider-context-assumptions.md) | partial | Requiring an authoritative context window for pressure presentation and one universal threshold pair.

The PTY supervisor and providers recover exact harness conversations from provider-owned
persistence; hvir does not guess ambient sessions or preserve PTYs in a daemon.

### [ADR-007 — Per-tab view mode: rendered / source / diff](adr/ADR-007-explicit-view-modes.md)

> Lifecycle: Active

Every tab exposes one visible, sticky representation mode with predictable defaults and
sandboxed HTML rendering.

### [ADR-008 — Workspaces: project → worktree tiers](adr/ADR-008-project-worktree-workspaces.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-023](adr/ADR-023-closed-workspace-lifecycle.md) | partial | Every present discovered worktree remaining open and visible.
> Superseded by: [ADR-024](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md) | partial | Registration or discovery implying renderer terminal runtime materialization.
> Superseded by: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | Periodic Git work refreshing activity for every open workspace.
> Superseded by: [ADR-033](adr/ADR-033-successful-discovery-dismisses-missing-workspaces.md) | partial | Missing worktrees remaining visible until explicit dismissal.

Host-qualified registered projects own discovered worktree workspaces without making hvir a
worktree orchestrator.

### [ADR-009 — Notifications: focus clears, parents aggregate](adr/ADR-009-hierarchical-attention.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-019](adr/ADR-019-working-output-is-not-actionable-attention.md) | partial | Classifying ongoing post-submission output as actionable new-output attention.

Terminal focus is the single clearing rule; workspace/project and OS surfaces only aggregate
the appropriate unseen child attention.

### [ADR-010 — Remote projects: `ProjectHost` seam, host-qualified paths, no remote server](adr/ADR-010-project-host-remote-boundary.md)

> Lifecycle: Active

All project operations and paths are host-qualified behind `ProjectHost`; SSH remains a
bounded transport owned by one logical host, not an installed remote service.

### [ADR-011 — Distribution: one npm launcher, native payloads](adr/ADR-011-npm-native-payload-distribution.md)

> Lifecycle: Superseded
> Superseded by: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | full | Entire decision.

One npm launcher selects integrity-checked native payloads for the supported Linux and
Apple-silicon macOS targets.

### [ADR-012 — Harness providers and launch profiles, not an extension host](adr/ADR-012-harness-providers-launch-profiles.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-015](adr/ADR-015-missing-resume-artifact-blocks-fresh-launch.md) | partial | Definitely absent or empty resume artifacts implicitly starting a fresh harness.
> Superseded by: [ADR-024](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md) | partial | Bare Shell defaults implicitly launching a session in an empty workspace.
> Superseded by: [ADR-036](adr/ADR-036-retire-static-harness-risk-classification.md) | partial | Provider launch-risk rules, derived risk in profile launch revision, and risk classification and acknowledgment.

Trusted main-owned providers supply exact harness semantics; data-only profiles customize
launches without opaque shell commands or a third-party extension platform.

### [ADR-013 — User-activated loopback web panes over `ProjectHost` routes](adr/ADR-013-user-activated-loopback-web-panes.md)

> Lifecycle: Active

Explicit terminal-link activation creates a bounded, authenticated, workspace-owned route to
a hostile isolated web pane while preserving remote loopback origins.

### [ADR-014 — Modular monolith ownership and dependency discipline](adr/ADR-014-modular-monolith-ownership.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-035](adr/ADR-035-bounded-osc52-clipboard-write.md) | partial | Expiry and removal metadata requirement for the named terminal-runtime.ts 600-line non-growth cap.
> Superseded by: [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Architecture hotspot budgets paragraph: complete source budgets and extended dependency enforcement; authority/seam checks stay blocking.

Feature ownership, inward dependency direction, typed resource lifetimes, explicit style
order, seam checks, and blocking hotspot ratchets govern the existing process boundaries.

### [ADR-015 — Missing resume artifacts block implicit fresh launches](adr/ADR-015-missing-resume-artifact-blocks-fresh-launch.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Definitely absent or empty resume artifacts implicitly starting a fresh harness.

A requested exact resume whose qualified provider artifact is missing remains visibly
unavailable without spawning a fresh harness or replacing the retained recovery identity.

### [ADR-016 — Bounded local runtime diagnostics](adr/ADR-016-bounded-local-runtime-diagnostics.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-025](adr/ADR-025-remove-renderer-responsiveness-diagnostic.md) | partial | Responsiveness episode candidate and its opt-in renderer diagnostic experiment.

Fixed-schema, content-free diagnostic evidence flows through one bounded local owner while
feature recovery stays feature-owned, workbench health remains separate from terminal attention,
and diagnostic sessions stay explicit, droppable, and local. The owner-by-owner [layout-integrity
evaluation](layout-integrity-evaluation.md) retains layout postconditions as pure or focused
Electron conformance and promotes no runtime detector.

### [ADR-017 — Defer direct diagnostic report delivery to harnesses](adr/ADR-017-defer-direct-diagnostic-report-delivery.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-026](adr/ADR-026-explicit-ssh-image-paste.md) | partial | Remote image staging and PTY injection prohibition only for explicit image paste in an exact supported focused terminal.
> Superseded by: [ADR-032](adr/ADR-032-explicit-document-review-handoff.md) | partial | PTY text delivery prohibition only for explicit prepared document-review payloads through revisioned atomic bracketed paste and exact PTY authority.

Preview plus explicit Copy or Save remains the report boundary until a bundled provider can prove
exact-session semantic submission, truthful host and attachment behavior, and revocable lifecycle
semantics without generic PTY injection or new persistence.

### [ADR-018 — Script-free first-use native payload preparation](adr/ADR-018-script-free-native-payload-preparation.md)

> Lifecycle: Superseded
> Superseded by: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | full | Entire decision.

Platform packages carry no lifecycle scripts; the launcher verifies and atomically prepares one
common archived payload lifecycle in a bounded per-user cache while npm retains installation,
platform selection, integrity, and provenance authority.

### [ADR-019 — Working output is not actionable attention](adr/ADR-019-working-output-is-not-actionable-attention.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | Classifying ongoing post-submission output as actionable new-output attention.
> Superseded by: [ADR-034](adr/ADR-034-project-name-working-presentation.md) | partial | Working presentation being confined to the terminal row.

Ongoing output after a submitted turn remains visible as low-salience Working state while
workspace and project rollups count only actionable Ready and bell signals.

### [ADR-020 — Two explicit recovery skips forget the hvir record](adr/ADR-020-two-explicit-recovery-skips-forget-record.md)

> Lifecycle: Active
> Supersedes: [ADR-006](adr/ADR-006-exact-harness-recovery.md) | partial | Indefinite recovery-record retention until explicit close.

One explicit skip retains and marks a decision-ready recovery record; a second consecutive skip
forgets only hvir's host-qualified metadata while provider-native recovery remains untouched.

### [ADR-021 — System Git decides dirty navigation safety](adr/ADR-021-system-git-dirty-navigation-safety.md)

> Lifecycle: Active
> Supersedes: [ADR-005](adr/ADR-005-system-git-engine.md) | partial | Clean-worktree navigation prerequisite and handing every dirty branch switch or pull to the terminal.

Explicit branch switches and fast-forward pulls may run with working-tree changes; system Git
decides whether it can preserve them while hvir retains its bounded mutation and authority model.

### [ADR-022 — Platform-native installation from immutable GitHub Releases](adr/ADR-022-platform-native-github-release-installation.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-011](adr/ADR-011-npm-native-payload-distribution.md) | full | Entire decision.
> Supersedes: [ADR-018](adr/ADR-018-script-free-native-payload-preparation.md) | full | Entire decision.
> Superseded by: [ADR-028](adr/ADR-028-capability-based-debian-linux-installation.md) | partial | Linux support matrix and unconditional Ubuntu AppArmor integration.

One release-owned installer selects and verifies platform-native packages from an immutable
GitHub Release; native package managers own privileged installation and removal, while npm
distribution is retired after cumulative acceptance.

### [ADR-023 — Closed workspaces unload and resurface on bounded Git activity](adr/ADR-023-closed-workspace-lifecycle.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Every present discovered worktree remaining open and visible.
> Superseded by: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | Fixed per-worktree periodic status cadence.

Present inactive worktrees may close without changing Git; closed workspaces retain no runtime and
return without activation after comparable bounded Git activity or successful rediscovery.

### [ADR-024 — Demand-driven terminal workspace lifecycle](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Bare Shell defaults implicitly launching a session in an empty workspace.
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Registration or discovery implying renderer terminal runtime materialization.

Registered worktrees allocate no terminal runtime by registration alone; explicit materialization,
session, PTY, presentation, and focus lifecycles remain independently owned.

### [ADR-025 — Remove the renderer-responsiveness diagnostic](adr/ADR-025-remove-renderer-responsiveness-diagnostic.md)

> Lifecycle: Active
> Supersedes: [ADR-016](adr/ADR-016-bounded-local-runtime-diagnostics.md) | partial | Responsiveness episode candidate and its opt-in renderer diagnostic experiment.

The low-confidence Long Tasks experiment and its complete opt-in runtime/reporting surface are
removed; independent capacity coverage, development measure containment, and Electron's
high-confidence unresponsive lifecycle remain at their owning seams.

### [ADR-026 — Explicit SSH image paste through private remote materialization](adr/ADR-026-explicit-ssh-image-paste.md)

> Lifecycle: Active
> Supersedes: [ADR-017](adr/ADR-017-defer-direct-diagnostic-report-delivery.md) | partial | Remote image staging and PTY injection prohibition only for explicit image paste in an exact supported focused terminal.

An explicit paste gesture may privately stage a bounded local clipboard PNG on an SSH host and
insert its path into an exact supported native harness composer, with no daemon, submission,
generic prompt delivery, or repository artifact.

### [ADR-027 — Demand-driven Git workspace activity](adr/ADR-027-demand-driven-workspace-activity.md)

> Lifecycle: Active
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Periodic Git work refreshing activity for every open workspace.
> Supersedes: [ADR-023](adr/ADR-023-closed-workspace-lifecycle.md) | partial | Fixed per-worktree periodic status cadence.

Periodic discovery no longer implies status for every open worktree; exact activity status is
demand-driven, clean closed workspaces retain bounded sampling, and stable dirty filters cannot
form an unbounded passive write loop.

### [ADR-028 — Capability-based Debian Linux installation](adr/ADR-028-capability-based-debian-linux-installation.md)

> Lifecycle: Active
> Supersedes: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | partial | Linux support matrix and unconditional Ubuntu AppArmor integration.

Linux installation depends on Debian package tools, runtime ABI, libraries, and a production
Chromium sandbox rather than distribution identity; Ubuntu 24.04 remains the conditional
AppArmor integration case and the same release artifacts are accepted across representative
userspaces on both architectures.

### [ADR-029 — Distinct signed macOS SSH acceptance channel](adr/ADR-029-distinct-macos-ssh-acceptance-channel.md)

> Lifecycle: Active

A contributor-only, Developer ID signed macOS application uses a distinct bundle identity and
state root for LAN SSH coexistence acceptance while the installed release remains the sole user
installation.

### [ADR-030 — Bounded project file operations and explicit external-source authority](adr/ADR-030-bounded-project-file-operations.md)

> Lifecycle: Active

One main-owned coordinator applies fixed targeting, confinement, collision, transfer,
verification, deletion, and lifecycle policy over immediate `ProjectHost` primitives; explicit
operation-scoped grants bound application-host sources outside registered projects.

### [ADR-031 — Transparent provider context assumptions](adr/ADR-031-transparent-provider-context-assumptions.md)

> Lifecycle: Active
> Supersedes: [ADR-006](adr/ADR-006-exact-harness-recovery.md) | partial | Requiring an authoritative context window for pressure presentation and one universal threshold pair.

Trusted bundled providers may expose a visible fixed context-capacity assumption and
provider-specific pressure thresholds through the serializable capability catalog while the
renderer remains provider-neutral and reported windows retain precedence.

### [ADR-032 — Explicit document review anchors and provider-safe handoff](adr/ADR-032-explicit-document-review-handoff.md)

> Lifecycle: Active
> Supersedes: [ADR-017](adr/ADR-017-defer-direct-diagnostic-report-delivery.md) | partial | PTY text delivery prohibition only for explicit prepared document-review payloads through revisioned atomic bracketed paste and exact PTY authority.

Host-qualified Markdown review uses exact on-disk anchors, bounded local persistence, explicit
payload bytes and destinations, and revisioned provider composer contracts through PTY authority.

### [ADR-033 — Successful discovery dismisses missing workspaces](adr/ADR-033-successful-discovery-dismisses-missing-workspaces.md)

> Lifecycle: Active
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Missing worktrees remaining visible until explicit dismissal.

Current successful Git discovery automatically dismisses prunable and omitted workspaces through
one host-qualified resource-cleanup lifecycle without mutating the repository.

### [ADR-034 — Project-name Working presentation](adr/ADR-034-project-name-working-presentation.md)

> Lifecycle: Active
> Supersedes: [ADR-019](adr/ADR-019-working-output-is-not-actionable-attention.md) | partial | Working presentation being confined to the terminal row.

Provider-neutral Working state may animate a project name without becoming actionable attention,
changing navigation width, or overriding reduced-motion preferences.

### [ADR-035 — Bounded OSC 52 clipboard write](adr/ADR-035-bounded-osc52-clipboard-write.md)

> Lifecycle: Active
> Supersedes: [ADR-014](adr/ADR-014-modular-monolith-ownership.md) | partial | Expiry and removal metadata requirement for the named terminal-runtime.ts 600-line non-growth cap.

A live terminal may place bounded, decoded OSC 52 text on the application-host clipboard without
receiving any read access; valid text remains exact and main independently validates IPC authority
and UTF-8 byte size.

### [ADR-036 — Retire static harness risk classification](adr/ADR-036-retire-static-harness-risk-classification.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Provider launch-risk rules, derived risk in profile launch revision, and risk classification and acknowledgment.

Launch syntax is not current runtime permission state; hvir removes profile-derived risk and
acknowledgment while preserving exact provider, host, artifact, and recovery authority.

### [ADR-037 — Promote tested pull-request candidates](adr/ADR-037-promote-tested-pull-request-candidates.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-038](adr/ADR-038-coherent-ci-attempts.md) | partial | First-attempt-only and rerun restrictions on otherwise exact candidate CI evidence.

Strict first-attempt pull-request checks admit one exact candidate tree to merge and release,
while native certification moves to Release and capacity evidence moves to controlled machines.

### [ADR-038 — Trust one coherent CI attempt per candidate](adr/ADR-038-coherent-ci-attempts.md)

> Lifecycle: Active
> Supersedes: [ADR-037](adr/ADR-037-promote-tested-pull-request-candidates.md) | partial | First-attempt-only and rerun restrictions on otherwise exact candidate CI evidence.

One complete workflow attempt may certify an exact candidate after approval or an explicit full
rerun, while partial reruns and cross-attempt job assembly remain ineligible.

### [ADR-039 — Exact provider-derived session forks](adr/ADR-039-exact-provider-derived-session-forks.md)

> Lifecycle: Active

Harness sessions start only as fresh launches, exact resumes of registered identities, or explicit
provider-derived branches of registered identities; ambient transitions are never inferred.

### [ADR-040 — Complete source budgets and dependency policy](adr/ADR-040-complete-source-budgets-and-dependency-policy.md)

> Lifecycle: Active
> Supersedes: [ADR-014](adr/ADR-014-modular-monolith-ownership.md) | partial | Architecture hotspot budgets paragraph: complete source budgets and extended dependency enforcement; authority/seam checks stay blocking.

Every maintained source file has a blocking budget, with a 500-line comfort signal, a 1,000-line
default, exact prior authorization for exceptions, and distinct runtime-cycle and type-direction
enforcement; ADR-014's ownership discipline remains accepted.

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
│ Projects bar — project tabs (host badge and attention rollups);    │
│ persistent worktree/workspace context tier beneath                 │
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
view (ADR-007). Git change details stay in the Git and file views instead of adding
persistent counts to project and workspace navigation.

### Workspaces
First-class multiple directories, without VSCode's multi-root heaviness. Two tiers:
**project** (registered) → **worktrees** (discovered), per ADR-008 — a workspace = a
worktree = a place an agent is working, with notification rollups at each tier.

### Global Sessions
The [Sessions ownership and topology-feasibility gate](sessions-ownership-and-feasibility.md)
defines the demand-scoped read-only projection, usage observation, exclusive live-terminal
surface lease, and current provider-topology boundary. It composes the existing session,
PTY, host, provider, attention, runtime, and `TerminalPane` owners without creating a global
authority or background observer.

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
