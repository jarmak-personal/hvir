# Phase 4 — SSH hosts

**Read first:** [`00-overview.md`](00-overview.md); design.md ADR-010 (this phase
implements it), ADR-005/006 (why git and PTYs are already transport-agnostic), §9 open
questions (dtach/abduco, remote watch strategy).

## Goal

`SshHost` as a second `ProjectHost`: projects on remote machines browse, view, save,
diff, and run terminals exactly like local ones. If Phase 1's seams held, **no renderer
code changes in this phase** — it's all behind the interface. A mixed set of local and
remote projects is the normal case, not a mode.

**Current status:** the transport, registry, auth UI, project picker, reconnect state,
watch tiers, cache, PTY path, and remote-Git broker are implemented. Automated tests
cover config merging, modern encrypted-key prompting, host-key reuse, and the shared
local confinement behavior. The acceptance checklist remains open until it is exercised
against a real configured SSH host, including a network drop and interactive TUI.

**UX amendment (2026-07-12):** remote work is a session flow, not a host/path form. The
user first chooses and connects to an SSH alias, then opens a folder on that connected
host; afterward hvir behaves exactly like a local session while continuously showing a
quiet remote-context indicator. The redesign is tracked in
[`03-05-review-followups.md`](03-05-review-followups.md) and must land before Phase 4
acceptance.

## Tasks

### Connection layer
- [x] `SshHost` on the `ssh2` npm package: one multiplexed client per host config,
      exec channels for `exec`/`spawnPty` (pty: true), SFTP for
      `readFile`/`writeFile`/`readdir`/`stat`.
- [x] Host config: parse `~/.ssh/config` for Host aliases, hostname, user, port,
      IdentityFile (verify a maintained parser package vs hand-rolling the subset).
      A host in hvir is referenced by its alias.
- [x] Auth ladder: ssh-agent first, then identity files, then interactive prompts
      (passphrase / password / keyboard-interactive for 2FA) surfaced through a proper
      renderer dialog — never silently hang.
- [x] Keepalives + reconnect with backoff. Connection state (connected / reconnecting /
      failed) exposed as events; renderer shows it on the project.

### Behavior on top
- [x] Enforce registered-root confinement after canonicalization for every remote
      filesystem operation and PTY cwd. Resolve symlinks (including parent components)
      before authorization so a project-internal link cannot escape the root; define
      and test the equivalent local behavior at the same trust boundary.
- [x] Remote PTYs through the supervisor: `spawnPty` runs the command in an exec
      channel with a PTY; resize propagates; `HarnessAdapter` commands compose (the
      supervisor runs `claude ...` on the host — the adapter doesn't know it's remote).
- [ ] Remote git: confirm the Phase 3 git slice works unchanged through
      `SshHost.exec` (it should — fix seam leaks if not).
- [x] `watch` implementation, tiered (ADR-010): **polling** of open-tab files and git
      status as the baseline; capability-detect `inotifywait` at connect time and
      stream `inotifywait -rm` over an exec channel where available. Record which tier
      a host got.
- [x] Read caching for tree listings and file reads with watch/poll invalidation, so
      latency degrades freshness, never responsiveness (§3.2).

### UX
- [x] Session flow: choose a local/SSH host, connect and authenticate first, then browse or
      enter a folder on that host using the shared lazy directory tree. Keep the active
      host/root and connection state visible.
- [x] Explicit disconnect/reconnect lifecycle: stop watches and PTYs, close the transport,
      retain stale tabs, disconnect the replaced host on session switches, and gracefully
      close every SSH client before app quit.
- [x] Disconnected project state: tabs show cached content marked stale; terminals show
      exited; reconnect restores and (Phase 6+) offers session resume.
- [ ] Investigate remote-session survivability across SSH drops: prototype wrapping
      remote harness PTYs in `dtach` or `abduco` (transparent, no rendering layer —
      unlike tmux). Record the outcome as an ADR or an updated open question. Stretch —
      do not block the phase on it.

## Acceptance criteria
- [ ] A project on a remote host: tree browses, files open in all view modes, save
      works, diff vs HEAD works — through unchanged renderer code.
- [ ] `claude` (or any TUI) runs in a remote terminal pane and feels responsive.
- [ ] Kill the network mid-session: UI stays responsive, project shows disconnected,
      reconnect recovers browsing and terminals without an app restart.
- [ ] Auth: key-with-passphrase and 2FA-style keyboard-interactive both prompt in-app
      and succeed.
- [ ] Editing a remote file externally is reflected in an open tab within the polling
      interval.
- [x] Status table updated.

## Non-goals
Remote worktree discovery UI (Phase 7 — but it must work through `ProjectHost`, which
this phase guarantees). Jump hosts / ProxyJump, port forwarding, SFTP file-manager
features. A persistent installed remote agent — rejected in ADR-010, hold the line.
