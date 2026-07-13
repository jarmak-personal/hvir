# Phase 4–5 deep-audit follow-ups

**Source:** three independent read-only audits of the integrated SSH, Git, and renderer
work on 2026-07-13, after real-host verification of remote browsing, tree refresh,
terminal rendering, blame, and a 400+ commit history.

This queue is part of the Plan of Record. It excludes already-recorded work such as the
Git topology graph, GitHub/GitLab alerts, the macOS cold-dev/white-renderer investigation,
and the remaining real-host auth/network acceptance matrix. Check items in the same
commit that implements and verifies them.

**Implementation status (2026-07-13):** all engineering items below are complete. The
focused SSH matrix, full verification suite, and production Electron smoke are green.
Sustained real-host use was accepted for Phase 4/5; deliberately inducing a network cut and
every specialized credential variant was declined, with that residual risk recorded rather
than represented as tested. The remaining unchecked rows are broader automation coverage,
not known implementation defects.

## P0 — data safety and trust boundaries

- [x] **Make dirty buffers lossless across ordinary navigation.** Reopening an existing
      dirty tab must focus it without rereading disk; asynchronous reads need a generation
      guard; closing a dirty tab, closing the window, renderer reload, and session replacement
      must confirm or recover the unsaved buffer. A dirty dot must never survive after its
      content was silently replaced.
- [x] **Repair the SSH auth error contract.** Recoverable `ssh2` agent/signing errors must
      continue through identity, keyboard-interactive, and password methods. Keep a persistent
      error listener so a consumed one-shot handler cannot turn the later fatal error into an
      unhandled main-process exception or leak a client that eventually becomes ready.
- [x] **Make the Git worker broker a real main-side boundary.** Replace raw permissive Git
      argv forwarding with a narrow operation/subcommand/flag policy. Reject extra `-C`, `-c`,
      `--git-dir`, `--work-tree`, `--exec-path`, shell aliases, helper-running commands, and
      any path/global option not required by the Git engine. Timeout must abort the host call.
- [x] **Open deleted and historical paths as diffs.** Git confinement must permit a missing
      leaf by authorizing its nearest existing canonical ancestor, without weakening the
      project-root boundary. Missing working/revision content becomes the empty side. Deleted
      parent directories work too.
- [x] **Report every untracked file honestly.** Use porcelain `--untracked-files=all` so a
      new directory is not an unopenable pseudo-file. Show real additions or omit counts;
      never present fabricated `+0 -0` statistics.
- [x] **Keep diff content and labels truthful.** Unsaved working content belongs only in
      working-tree/HEAD contexts, never historical or merge-base→HEAD branch-point diffs.
      Historical tabs hide the irrelevant base selector and identify their parent revision.
      Open diffs refresh when their file, index, HEAD, or selected base changes.

## P0/P1 — SSH lifecycle and remote reliability

- [x] Gate all client close/error effects by client identity or connection generation.
      Explicit disconnect force-destroys a socket after its graceful timeout; a late old-client
      close cannot demote a healthy replacement or start a second reconnect chain.
- [x] Report remote PTY exit exactly once from either SSH `exit` or `close`. A channel that
      closes without exit-status synthesizes an unknown/nonzero exit so the PTY supervisor and
      renderer cannot retain a zombie session.
- [x] Make pending PTY spawn part of session lifecycle. Disconnect, project replacement,
      renderer loss, and `disposeAll` invalidate/cancel unpublished spawns and revalidate the
      active session before publishing them.
- [x] Treat post-auth capability and folder-suggestion probes as best-effort. Failure falls
      back to polling or `/`; it does not mark an authenticated transport failed, publish a
      half-connected state, or leak a client.
- [x] Canceling any auth prompt cancels that connection attempt and all later prompts. Pending
      prompts are canceled or replayed across renderer reload/crash rather than becoming an
      invisible 120-second wait.
- [x] Make remote save crash-safe: write a sibling temporary file, preserve appropriate mode,
      check for unseen external changes, and atomically rename where supported. A network drop
      must not truncate the only copy.
- [x] Make polling-tier acceptance reliable and bounded. Detect same-size rewrites inside
      SFTP v3's one-second mtime granularity, prioritize clean open files and Git metadata,
      avoid a continuous full-tree scan, and keep slow safety refreshes adaptive/single-flight.
- [x] Separate synthetic tree-liveness pulses from Git invalidation. An idle SSH project must
      not run the multi-command Changes pipeline every two seconds; real bursts coalesce into
      one active refresh plus at most one trailing refresh. Read-only Git disables optional
      index writes, and short-lived SSH execs retain session headroom for PTY/SFTP/watch
      channels so a large graph cannot turn refresh pressure into `CHANNEL_OPEN_FAILURE`.
- [x] Close remote cleanup edge cases: root `/` cache invalidation, inotify move/remove and
      directory classification, and standard default identity files when neither an agent nor
      explicit `IdentityFile` is available.

## P1 — Git correctness, races, and scale

- [x] Model branch-point availability and selected base explicitly. A shallow/no-merge-base,
      unconventional-default, timeout, and genuinely empty branch must not all display as
      `Branch point 0`; never substitute the feature branch's upstream as the default branch.
- [x] Support projects opened below their containing repository root without authorizing the
      parent tree. Keep Git `-C` inside the selected root and scope commands with repository
      prefix/pathspec information.
- [x] Reset GitPanel state on root/disconnect and generation-key every Changes, History, and
      commit-detail response. Prevent duplicate initial history loads and stale A→B selection
      responses. Cached disconnected entries are visibly stale and noninteractive.
- [x] Present unborn and non-repository projects as normal contained states rather than raw
      fatal Git output; never leave the previous project's Changes visible beneath a new root.
- [x] Replace increasing `git log --skip=N` rescans with stable continuation/streaming and
      virtualize accumulated history. Share that model with the topology graph so deep history
      is not quadratic in Git work or linear in live DOM nodes.
- [x] Support legal unusual repositories: parse tab-containing NUL-delimited numstat paths
      without truncation and accept SHA-1 or SHA-256 object IDs throughout detail/blame/diff.
- [x] Keep large blame/Changes/detail rendering bounded: transfer compact blame runs/shared
      commit metadata and materialize only visible gutter/list rows.

## P1/P2 — integrated UX quality

- [x] Add a Restart action for an exited plain shell.
- [x] Make safe in-project symlinked files and directories browsable while retaining canonical
      confinement; clearly mark links rather than rendering them as disabled mystery rows.
- [x] Preserve independent scroll position for source, rendered Markdown, diff, JSON, and YAML
      across tab/mode changes.
- [x] Make session/auth dialogs keyboard-modal (`role=dialog`, `aria-modal`, initial focus,
      Escape, and focus containment) and give ARIA trees the expected arrow-key behavior.
- [x] Disambiguate duplicate Git basenames with compact repository-relative context. Give
      loading, clean, empty-history, unborn, non-repository, stale, and operational-error states
      distinct presentations.
- [x] Route repository-relative Markdown images through the owning `ProjectHost` or show an
      explicit unavailable state; remote documentation must not silently lose screenshots.
- [x] Protect paint from very large source files. Do not synchronously construct a 64 MiB
      CodeMirror document on the renderer thread; use a bounded read-only presentation or a
      much lower explicit source-view limit.

## Verification matrix

- [x] Focused unit/integration coverage: recoverable agent error, delayed old close, capability
      probe failure, PTY close without status, pending-spawn/session race, same-size polling edit,
      and atomic-save failure injection.
- [ ] Git coverage: malicious broker argv, deleted file/directory, untracked directory/counts,
      shallow/no-merge-base, selected subdirectory, non-Git/unborn UI, tab path, SHA-256 objects,
      rapid detail/root races, and real multi-page history.
- [ ] Renderer coverage: dirty reopen/close/window recovery, stale diff refresh, historical
      selector semantics, disconnected Git state, terminal restart, scroll restoration,
      symlink rows, and keyboard-modal dialogs/tree navigation.
- [x] Full `npm run verify` and the production Electron smoke remain green.
- [x] Repeat the real SSH regression/auth/network matrix. Sustained remote use, login,
      reconnect, Git, and viewer behavior were accepted. A deliberate network cut and every
      specialized credential variant were not induced; the user explicitly accepted that risk.

## What the audit found solid

Preserve these properties while fixing the queue: staged SSH session UX, loud changed-host-key
handling, prompt IPC validation, shared SFTP reuse, incremental UTF-8 decoding, robust shell
quoting, serialized high-level session operations, clean terminal reconnect, stable Files/Git/
Harness navigation, off-renderer Git parsing, merge-base→HEAD branch semantics, ordinary
Unicode/space/rename parsing, and the prohibition on Git write operations.
