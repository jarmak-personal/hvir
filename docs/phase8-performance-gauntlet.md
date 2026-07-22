# Phase 8 performance and robustness gauntlet

This is the reusable release check for hvir's “nothing blocks the paint” constraint. Run
it on a modest primary-platform machine before a release and after changes to watching,
Git, terminal rendering, SSH pooling, telemetry, or layout.

## Automated run

```sh
npm run gauntlet
```

The script runs seam enforcement, lint, both TypeScript builds, all unit/integration
tests, the default unpackaged Electron groups, and the 30-second capacity smoke. Set
`HVIR_SKIP_CAPACITY=1` only for a quick preflight; that is not release evidence.

`npm run smoke:macos` is the matching Apple-silicon correctness check for the focused PTY,
viewer-position, and retained platform-contract groups. Packaged correctness remains a separate
distribution boundary: after building the matching platform and launcher tarballs, run
`npm run smoke:packaged` to verify installation, launcher and native architecture selection,
application/native-PTY/worker loading, preview-protocol handling, and platform geometry. Neither
command is a performance measurement, and evidence from one platform does not substitute for
another.

The capacity smoke mounts 12 real Ghostty panes, produces output in all PTYs, churns a
watched file, alternates Files/Git, samples animation-frame and click latency, samples
Electron's total working set, and then reloads. It fails at p99 latency >=100 ms, any
unexplained stall >500 ms, net 30-second working-set growth >256 MiB, an orphaned PTY,
or failure to recover all terminals with Changes and History usable. Ghostty scrollback
is bounded to 10,000 lines per terminal.

## Workspace and error matrix

Use five or more workspaces across at least two projects. Include a main checkout, a live
linked worktree, a terminal-created worktree, a plain non-Git directory, and a prunable
record. Repeat on local and SSH hosts where the row applies.

1. Create/delete the live worktree from a terminal while Files and Git are open. Confirm
   discovery, labels, changed-count rollups, persistent single-workspace context, and
   warm state when switching rapidly.
2. Exercise cancel and confirm for stale-record pruning. Confirm it removes only Git's
   stale administration record and never an existing directory.
3. Generate tracked, staged, untracked, ignored, rename, and conflict states while
   alternating Changes, History, graph, blame, and branch navigation. A Git failure must
   stay inside the rail as a calm error.
4. Open a >5 MiB text file, a malformed CSV, a missing rendered link, an image, and a
   large JSON document. Confirm bounded previews/workers and contained renderer errors.
5. Disconnect/reconnect the host while cached files, split viewers, split terminals, and
   dirty viewer content exist. Cached state stays visible, mutations fail closed, and no
   white screen or silent data loss occurs.

## Real SSH topology and teardown

Repeat the exact protocol in
[`07.5-ssh-capacity.md`](plan/07.5-ssh-capacity.md#real-host-robustness-protocol):
12+ terminals, two SSH projects, three workspaces, both telemetry adapters, live Git/file
churn, reconnect, quit, and recovery. Do not alter `sshd_config` for the test.

After normal quit, run these read-only checks as the same remote user:

```sh
find /tmp -maxdepth 1 -user "$(id -un)" -name 'hvir-telemetry.*' -print
pgrep -afu "$(id -u)" 'tail .*hvir-telemetry|hvir-telemetry.*tail' || true
```

Both outputs should be empty. Record host OS, readable `MaxSessions`, project/workspace
count, terminal/adapter mix, authentication prompts, latency line, memory line, log
errors, and teardown output in the release notes.

## Long-session memory check

For a release candidate, leave the topology active for at least two hours. Every 15
minutes, record hvir's total working set from Activity Monitor/System Monitor while
rotating terminals, workspaces, Git, a large file, Markdown, CSV, and image tabs. Growth
may step up as lazy renderers load, then must plateau under a stable tab/terminal count.
Treat monotonic post-warmup growth, a renderer crash/OOM, or scrollback exceeding 10,000
lines per terminal as a failure and retain the sample table with the release evidence.

## Latest automated evidence

On 2026-07-15, the full gauntlet passed on the development MacBook Air:

- seam checks, scoped lint, both TypeScript builds, and 39 test files / 272 tests passed;
- production smoke covered Git, terminal lifecycle/recovery, themes, richer renderers,
  terminal/viewer splits, settings, file handoff, and a bounded >5 MiB preview;
- the 12-terminal probe measured **17.7 ms p99 / 17.8 ms max** over 75 UI transitions,
  with 50 MiB net / 106 MiB peak working-set growth during the 30-second run; and
- all 12 terminals recovered after reload with Changes and History ready.

The local teardown audit was empty. This automated result does not replace the live SSH
topology or two-hour memory protocols above; both remain Phase 8 release acceptance work.
