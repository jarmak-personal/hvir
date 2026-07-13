# Phase 3–5 review follow-ups

**Source:** macOS hands-on review after the integrated Phase 4/5 slice (2026-07-12).
This is the active queue for regressions and workflow feedback that crosses the viewer
(Phase 3), SSH integration (Phase 4), and Git explorer (Phase 5). Keep the completed
phase records intact; check these items in the implementation commit that resolves them.

## P0 — stability and navigation

- [x] **Route links in rendered Markdown through hvir.** Intercept anchor clicks before
      browser navigation. Resolve relative paths against the rendered file's host-qualified
      parent directory, then open them through the normal tab/`ProjectHost` path. Preserve
      same-document `#anchors`; send explicit `http:`/`https:` links to the OS browser.
      Missing or out-of-root files must show a contained tab error and must not reload the
      renderer, tear down terminals, or collapse the file tree.
- [x] Disable MarkdownIt's automatic prose linkifier: bare repository filenames such as
      `design.md` must remain text rather than becoming `http://design.md`; explicit
      Markdown web links still work.
- [x] **Add a main-frame navigation guard.** Reject unexpected `will-navigate` events as
      defense in depth so malformed rendered content can never replace the workbench. Allow
      only the expected dev-server reload or packaged app document; external URLs open in
      the OS browser.
- [ ] **Diagnose and eliminate the solid-white renderer failure.** Exact observed sequence
      on macOS: several rendered-Markdown relative links failed to navigate, then switching
      a design document to source/raw made the entire window solid white and unresponsive.
      Cmd-Q still worked; relaunching hvir recovered it. It has not reproduced yet. Capture
      `will-navigate`/`did-fail-load`, `render-process-gone`, `unresponsive`, worker errors,
      and the active tab/mode transition so the next occurrence distinguishes unintended
      navigation, renderer crash/hang, and dev-server reload. A failure must leave a usable
      recovery surface rather than a permanently white window.
- [ ] **Remove the cold-dev Shiki dependency reload as a separate variable.** Reproduce on
      macOS after clearing Vite's dependency cache. Explicitly include Markdown/Shiki worker
      dependencies in renderer `optimizeDeps` so first use does not discover new dependency
      chunks and force a full-page reload. Vite's optimization notice may occur during
      startup, never in response to changing a tab's view mode. This is a plausible
      contributor to the observed sequence, not yet established as the white-screen cause.
- [ ] Add a cold-cache macOS regression check: first Markdown render, rendered → source,
      and an internal relative link all succeed without a renderer reload; open tabs, tree
      expansion, and the terminal survive.

The `task_policy_set` messages in the review log are Chromium/macOS process-policy noise;
track them only if they correlate with an observable hvir failure after the navigation and
dependency-reload fixes.

## P0 — SSH/Git stabilization review

- [x] Make connect/dispose race-safe: cancel a pre-ready connection even when `ssh2` emits
      no close event, ignore late closes from replaced clients, bound automatic reconnects,
      and ensure explicit disconnect cancels every reconnect path.
- [x] Queue renderer auth prompts by ID instead of replacing a single modal. Validate prompt
      responses at IPC, contain keyboard-interactive failures, cancel host prompts on
      disconnect, and stop modal reconnect prompting after cancellation/bounded retries.
- [x] Distinguish a changed saved host key from first contact. Show old and presented
      fingerprints in a high-risk dialog and require explicit out-of-band verification
      before replacing the trust-store entry.
- [x] Enforce the Git worker broker in main: active host/root only, canonical confinement,
      `git` only, bounded inputs/output, and a timeout. Record renderer-selected root
      authority and rejected alternatives in ADR-010.
- [x] Confirm before switching sessions when any source tab is dirty so the minor-edit
      feature cannot silently discard buffers.
- [x] Decode buffered exec, streaming exec, and remote PTY bytes with incremental UTF-8
      decoders so multibyte characters cannot corrupt at transport chunk boundaries.
- [x] Keep Git live after terminal operations: watch the resolved Git metadata directory
      without recursively watching objects, refresh History as well as Changes, suppress
      stale pagination appends, and degrade unborn/no-default-branch repos to a useful
      working-tree-only view.
- [x] Bound remote channel and lifecycle pressure: share one SFTP subsystem, prune inotify
      exclusions and fall back on watcher exit, serialize session lifecycle mutations,
      and contain invalid fire-and-forget IPC during renderer teardown.
- [ ] Cleanup tail: generate Markdown heading IDs for in-document anchors, clear blame data
      after saves, add `ssh_config Include` support, filter negated-only aliases, and decide
      whether reconnect should suggest the last project root rather than remote `$HOME`.

## P1 — viewer polish

- [x] **First-class agent task lists.** Render GFM `- [ ]` / `- [x]` items, including
      nesting, as polished disabled checkboxes, plus GitLab's `- [~]` inapplicable state.
      Rendered mode remains read-only; changing a task belongs in source mode so the UI
      never implies an unpersisted edit.
- [x] **Hot-reload rendered output in place.** A Vite update to Markdown/YAML/JSON/Mermaid
      renderer code invalidates the active worker and regenerates the current preview even
      when file content is unchanged. Preserve tab, tree, terminal, and scroll state rather
      than requiring the user to switch away and back.
- [ ] **GitHub/GitLab alerts.** Render blockquote alerts using the shared
      `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` syntax with accessible labels and restrained
      theme colors. Accept case-insensitive GitLab input and its optional custom title;
      ordinary blockquotes remain ordinary. Prefer a focused markdown-it extension, but a
      small token rule is acceptable if maintained plugins cannot preserve both dialects.
- [x] **Do not reserve the blame gutter while blame is off.** The current empty
      `.cm-blame-gutter` has `min-width: 165px`, which looks like an enormous line-number
      margin. Mount that gutter only when blame is enabled; keep CodeMirror's normal compact
      line-number gutter otherwise. Verify source and both diff editors on Linux and macOS.
- [x] **Rendered YAML.** Treat `.yaml`/`.yml` as renderable structured data. Parse in a
      worker with the maintained `yaml` package and reuse the lazy/collapsible JSON tree
      presentation. Surface multi-document YAML and parse errors clearly; never parse large
      YAML on the renderer thread.

## P1 — left-rail information architecture

- [ ] Replace the small child-owned Files/Git switches with one full-width rail navigation
      strip owned by the rail container: `Files | Git | Harness`. Files and Git are active;
      Harness reserves the Phase 6 location without leaking harness-specific behavior into
      either panel. Keep the changed-file badge on Git and connection state/project controls
      consistently above or beside the strip.
- [ ] Preserve each section's local state when switching: expanded directories and scroll,
      Git subview/history position, and eventually Harness selection.
- [ ] Runtime-smoke repeated Files ↔ Git switching so navigation never remounts unrelated
      viewer tabs or collapses the tree.

## P1 — SSH session workflow

- [x] Keep expected session failures contained: invalid/case-mismatched folder paths and
      cancelled SFTP watches surface as concise picker/session state, not rejected Electron
      handler stacks or close-time watcher errors in the launching terminal.
- [x] Make disconnect a complete session lifecycle: explicit Disconnect/Reconnect actions,
      no implicit reconnect from filesystem operations, cleanup of unopened picker hosts,
      automatic disposal when switching machines, last-window cleanup on macOS, and an
      awaited app-quit barrier for watchers, PTYs, workers, and SSH transports.
- [x] Resolve plain terminal shells on the owning `ProjectHost` so a local macOS `$SHELL`
      is never launched on a Linux SSH host. Make fallback polling single-flight with
      bounded error backoff so a slow recursive snapshot cannot exhaust SSH channels.
- [x] Honor `ssh2`'s async host-verifier and initial-auth callback contracts: wait for an
      explicit Trust Host action before accepting/rejecting, wrap the standard SHA-256
      fingerprint inside the dialog, and begin the auth ladder when server methods are not
      known yet instead of treating that state as authentication failure.
- [x] Replace the combined host/path form with a staged remote-session flow:
      **Connect to Host…** → select an SSH alias → connect/authenticate → select or enter a
      folder on that host → open the workbench. Local gets the parallel **Open Local
      Folder…** path. Do not ask for a remote path before the connection succeeds.
- [x] Add a narrowly scoped remote-folder picker backed by `ProjectHost.readdir` (directory
      selection only, not an SFTP file manager), plus recent folders per host and direct path
      entry for experienced users.
- [x] Use the same lazy host-qualified directory-tree presentation for Files and folder
      selection. Inject separate loaders so the Files tree remains confined to the active
      project while the pre-project picker can explore from `/`; auto-expand the suggested
      path, select folders in place, and keep direct path/recent-folder controls.
- [x] Once connected, remote hvir behaves like local hvir: the same Files/Git/Harness rail,
      viewer modes, terminal, shortcuts, and project controls. Renderer features must not
      branch on local vs SSH.
- [x] Keep remote context continuously visible without copying VS Code chrome: a quiet
      `ssh:<alias>` session indicator with connected/reconnecting/failed state and actions to
      disconnect, reconnect, change host, or return local. Do not repeat the project path in
      this strip; each rail panel header owns concise folder context. Local mode uses a
      low-noise `Local` label rather than hiding the session model.
- [x] Switching hosts/projects cleanly replaces the active session: preserve cached stale
      tabs for recovery, stop the old watch, end its terminals through the PTY supervisor,
      start the new host watch, and restore that host/root's tab state.
- [ ] Validate the flow first against a disposable localhost SSH server, then on a real host
      with agent auth, passphrase auth, and keyboard-interactive/2FA. Phase 4 acceptance stays
      open until this session flow—not the old combined form—passes.

## P1 — Git topology graph (Phase 5 scope amendment)

- [ ] Extend paged history data with parent hashes and decorated refs/branch heads from
      system Git through the existing worker/`ProjectHost` route.
- [ ] Spike the maintained `commit-graph` React component against real hvir history:
      dark-theme fit, merge/lane correctness, React 19 compatibility, incremental loading,
      keyboard/selection behavior, license metadata, and large-repository responsiveness.
      It natively accepts commits with parents and branch heads and supports infinite scroll.
- [ ] Decide placement from the spike: a dedicated full viewer graph is preferred for the
      primary workflow, with an optional compact lane strip in rail History. Do not squeeze
      the only graph into the 238px rail.
- [ ] If the spike fails, retain its commit-lane model but implement the narrow SVG lane
      renderer locally; do not adopt an editor extension or generic force-directed graph.
      `@gitgraph/js` is rejected as the default candidate because its repository is archived
      and describes itself as an illustration/presentation API rather than a repository-log
      viewer.
- [ ] Commit selection opens the existing commit detail; file selection opens historical
      diff tabs. Graph loading remains paged/off-thread and refreshes from host watch events.

## Acceptance

- [ ] A cold `npm run dev` on macOS completes the entire P0 scenario without a solid-white
      renderer failure, unexpected navigation, lost terminal, collapsed tree, or
      post-interaction Vite reload. A forced renderer crash/unresponsive test demonstrates
      an in-app recovery path without requiring Cmd-Q.
- [ ] YAML, compact source gutters, and the full-width rail navigation pass Linux/macOS
      smoke checks.
- [ ] The graph answers branch/merge topology at a glance on a merge-heavy repository and
      remains smooth on the largest repository available.
