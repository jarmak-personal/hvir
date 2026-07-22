# Phase 8 performance and robustness gauntlet

This is the reusable release check for hvir's “nothing blocks the paint” constraint. Run
it on a modest primary-platform machine before a release and after changes to watching,
Git, terminal rendering, SSH pooling, telemetry, or layout.

## Automated run

```sh
npm run gauntlet
```

The script runs seam enforcement, lint, both TypeScript builds, all unit/integration
tests, the default unpackaged Electron groups, and the capacity smoke. Set
`HVIR_SKIP_CAPACITY=1` only for a quick preflight; that is not release evidence.

`npm run smoke:macos` is the matching Apple-silicon correctness check for the focused PTY,
viewer-position, retained platform-contract, and terminal-presentation groups. Packaged
correctness remains a separate distribution boundary: after building the matching platform and
launcher tarballs, run `npm run smoke:packaged` to verify script-disabled installation,
first-use preparation from a read-only prefix, subsequent reuse, launcher and native architecture
selection, application/native-PTY/worker loading, preview-protocol handling, and platform
geometry. Neither command is a performance measurement, and evidence from one platform does not
substitute for another.

The capacity smoke first compares three 30-second Electron renderer-plus-GPU CPU samples
for one visible terminal with three matching samples for one visible and eleven hidden
idle terminals. The loaded interval then mixes continuous plain output, Codex-like
cursor/ANSI updates, synchronized-output bursts, and idle panes while churning a watched
file and alternating Files/Git. It reports renderer, GPU, and main-process CPU alongside
animation-frame, click-latency, and total-working-set evidence; it also verifies hidden
parse-versus-presentation counters, native data-event versus coalesced-delivery callbacks,
terminal writes, per-session buffered-byte peaks, and ten action-to-ready-and-exact-echo
launches under load against ten matching one-terminal baseline launches. Each loaded launch
must complete within one second and the loaded p95 must be no more than twice the baseline
p95. CPU evidence includes renderer, GPU, main, and aggregate Electron child-process usage.
Delivery buffers are capped at 64 KiB; visible output flushes
on the next frame and hidden output within 40 ms. The smoke fails when delivery is not
coalesced, a buffer exceeds its cap, the idle CPU median ratio exceeds 1.5, p99 latency is
>=100 ms, an unexplained stall exceeds 500 ms, net loaded-interval working-set growth exceeds
256 MiB, hidden presentation advances, a PTY is orphaned, or all terminals cannot recover
with Changes and History usable. Ghostty scrollback is bounded to 10,000 lines per terminal.

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

On 2026-07-22, the terminal-delivery and capacity-acceptance candidate passed its targeted
gates on the development MacBook Air:

- policy, lint, both TypeScript builds, and 130 test files / 892 tests passed;
- the focused real-Electron lifecycle preserved hidden ANSI/title/bell parsing, a current
  one-repaint reveal, exact input echo, and close;
- ten loaded terminal launches each produced one exact UI-input echo, with a **231 ms p95/max**
  against a 235 ms one-terminal baseline p95 (0.983 ratio and no launch above one second);
- the loaded 12-terminal interval routed 6,343 native data events into 3,658 bounded delivery
  callbacks and 3,665 terminal writes, a 42.3% callback reduction with a 276-byte peak buffer;
- 11 hidden panes parsed 1,881 writes with zero presentation frames while the visible pane
  advanced 1,783 frames;
- the three-window idle renderer-plus-GPU median ratio was 0.987, and the denser loaded interval
  measured **18.4 ms p99 / 18.7 ms max**, renderer/GPU/main/aggregate-child CPU of
  2.85%/1.36%/0.85%/4.24%, and 89 MiB net / 90 MiB peak working-set growth; and
- all 12 terminals recovered with Changes and History ready.

This separates the mechanisms: the feature router removes per-pane native subscription fan-out,
delivery coalescing reduces 6,343 routed events to 3,658 callbacks, and the earlier hidden-
presentation work still holds hidden frames at zero. The automated result does not replace the
live SSH topology or two-hour memory protocols above; both remain Phase 8 release acceptance work.
