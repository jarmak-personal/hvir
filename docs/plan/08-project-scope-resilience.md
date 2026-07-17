# Phase 8 follow-up — Project-scope resilience

**Read first:** [`00-overview.md`](00-overview.md), design.md §3, ADR-005, ADR-008,
and ADR-010. This follow-up closes the plain-directory item in the Phase 8 workspace
edge matrix and addresses the first-launch hang reproduced by opening a user's home
directory as a project.

## Problem statement

The launcher deliberately preserves its caller's working directory. Main then treated
that directory as an implicit project root, started a recursive Chokidar watch before
creating the window, and ran repository discovery/status work on a timer. A first-time
`hvir` invocation from `~` could therefore traverse the entire home directory (and fall
back to polling it after a watcher-capacity error) before the workbench painted. The
file tree itself was already lazy; the background watch and Git lifecycle were not.

The terminal recovery timeout in PR #17 is still useful defensive work, but cannot be
the root cause for a genuinely new user because there is no persisted terminal session
to resume.

## Product behavior

- A bare launch with no registered history opens the operating system's local folder
  picker. Cancel exits cleanly. A path supplied by the launcher/CLI is intentional and
  takes precedence over persisted history; a later bare launch restores history.
- Any chosen directory is valid. A plain directory is a file-first, lazy explorer with
  terminals and harnesses; Git navigation, status polling, ignored-file classification,
  and change decorations are absent until the root is a repository.
- Filesystem invalidation follows visible demand. The root is always watched one level
  deep; expanded directories and parents of open files are shallow watch interests.
  Closing/collapsing them removes the interest. Interests are host-qualified, confined
  to the active workspace, deduplicated, and capped at 128.
- Lazy directory listings retain directory-first grouping and sort numeric filename
  segments by value, so generated runs read as `1.txt`, `2.txt`, `10.txt`.
- One content-watch backend owns all current interests, including over SSH. Repository
  metadata remains a separate shallow watch because `.git` object storage is noisy.
  Creating `.git` at the root re-runs repository discovery.
- Git's detailed working-tree model shows at most 2,000 paths. When more exist, the UI
  says that results are limited, skips per-file untracked statistics and branch-point
  detail, withholds incomplete per-file decorations from the Files tree, and continues
  to treat the worktree as dirty. The host terminates status after a bounded NUL-record
  count (including rename pairs) or 20 MiB instead of buffering the complete pathological
  result. Git work and parsing remain in the utility process.
- The BrowserWindow is created before background watching/discovery begins, so a slow
  host or Git command cannot hold the first workbench paint.

## Implementation checklist

### Startup and registry

- [x] Remove `process.cwd()` as an implicit project argument.
- [x] Let `ProjectRegistry` restore stored projects without an initial root, and add a
      selected root only when an explicit argument or first-run picker supplies one.
- [x] Make explicit project arguments override the stored active project.
- [x] Show the native local directory picker only when both explicit root and history
      are absent; handle cancellation without a partial registry or window.
- [x] Create the window before starting project watches and workspace discovery.

### Demand-driven watch lifecycle

- [x] Extend `ProjectHost.watch` with bounded additional host-qualified paths so local
      Chokidar and SSH inotify/polling retain one backend per content watch.
- [x] Add a main-process watch controller with a shallow root watch, shallow dynamic
      interests, a separate shallow Git-metadata watch, batched renderer events, and
      serialized restart/disposal.
- [x] Add typed IPC for renderer watch interests and validate host, active root,
      canonical confinement, count, and path shape in main.
- [x] Publish expanded-directory interests from the lazy tree and open-file parent
      interests from the active workspace; disclose interest truncation calmly.
- [x] Preserve directory-first grouping while sorting numeric filename segments by
      value in each loaded directory.

### Plain directories and Git bounds

- [x] Do not mount Git rail work or request ignored-file decorations for known
      non-repositories.
- [x] Skip periodic worktree/status refresh for known plain-directory projects while
      retaining initial/manual discovery and root `.git` detection.
- [x] Cap detailed working-tree changes, preserve a truthful limited/dirty state, skip
      expensive follow-up statistics when capped, and show the cap in the Git rail.
- [x] Withhold partial Files-tree Git decorations when the capped status prefix is
      incomplete, while retaining the visible overall dirty signal.
- [x] Clamp workspace changed-count badges to a sentinel above the same cap.

### Verification

- [x] Unit-test first-run cancellation, history restore, and explicit-root precedence.
- [x] Unit-test local and SSH multi-path shallow watches plus controller confinement,
      replacement, batching, Git metadata, and disposal behavior.
- [x] Unit-test natural numeric filename ordering and the existing directory-first
      grouping.
- [x] Unit-test that limited Git status does not produce misleading per-path tree
      decorations.
- [x] Unit-test non-Git renderer gating and capped Git change/count semantics.
- [x] Run seam enforcement, lint, both TypeScript builds, and the focused/full test
      suites.
- [x] Exercise the watcher against a broad temporary home-shaped directory and run the
      production smoke; confirm bounded depth, responsive paint, lazy expansion, and no
      recurring Git status work for a known plain project.

## Acceptance criteria

- [x] `hvir` with no argument and no history never registers the caller's current
      directory without confirmation.
- [x] Opening a home-sized non-Git directory costs one root listing/watch plus explicit
      visible interests; it never recursively walks or polls the tree.
- [x] Files and terminals remain useful in a plain directory, and converting its root
      to a Git repository enables Git surfaces without reopening it.
- [x] A repository with more than 2,000 changes remains responsive and visibly reports
      the bounded result instead of attempting per-file detail for the entire set.
- [x] Local and SSH implementations preserve the `ProjectHost` seam and use bounded
      watch/transport capacity.

## Non-goals

A zero-project workbench, repository indexing, full-text search, LSP/editor features,
automatic project-root guessing, watching inactive projects, or changing Git data. The
folder picker is first-run registration, not a permanent welcome-mode architecture.

## Implementation evidence (2026-07-16)

- `npm run verify` passed seam enforcement, lint, both TypeScript builds, 44 test files /
  306 tests, and the installed-launcher help contract.
- The production Electron smoke passed the full window, renderer IPC, ProjectHost tree,
  Git rail, viewer, PTY, recovery, SSH prompt, layout, and shutdown workflow.
- New regressions cover first-run cancellation/history/explicit path and worktree
  precedence; shallow local home-shaped and multi-interest watching; SSH multi-path
  polling; canonical escape rejection and validation caching; controller batching/Git
  discovery/disposal; non-Git renderer gating; repository-to-plain
  count clearing; local/SSH bounded-output termination; and a real 2,001-change
  repository that skips per-file statistics and withholds incomplete tree decorations.
