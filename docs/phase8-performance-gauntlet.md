# Phase 8 performance and robustness gauntlet

This is the reusable release check for hvir's “nothing blocks the paint” constraint. Run
it on a modest primary-platform machine before a release and after changes to watching,
Git, terminal rendering, SSH pooling, telemetry, or layout.

## Automated runs

```sh
npm run gauntlet
```

The script runs seam enforcement, lint, both TypeScript builds, all unit/integration
tests, the default unpackaged Electron groups, and the controlled capacity-performance gate.
Set `HVIR_SKIP_CAPACITY=1` only for a quick preflight; that is not release evidence.

Pull-request and main-branch Linux CI use the evidence-only capacity command:

```sh
npm run smoke:capacity
```

It runs the same real Electron topology and samples. Exact terminal topology, hidden
presentation, bounded buffers, output delivery and coalescing, exact input echo, cleanup, and
recovery are blocking contracts. CPU, elapsed-time, frame/click latency, launch latency, and
working-set crossings are emitted under `[smoke:performance:evidence]` and do not fail a hosted
run. A bounded readiness deadline may still fail when the scenario cannot establish a semantic
contract; that failure names the missing state or owned resource rather than treating the
elapsed value as a performance verdict.

`npm run smoke:macos` is the matching Apple-silicon correctness check for the focused PTY,
viewer-position, retained platform-contract, and terminal-presentation groups. Native package
correctness remains a separate distribution boundary. On disposable matching hosts, the guarded
`npm run smoke:linux:installed` and `npm run smoke:macos:installed` checks exercise the
release-owned installer, install/update/removal lifecycle, production sandbox, command,
application, native PTY, worker, and platform geometry. Neither command is a performance
measurement, and evidence from one platform does not substitute for another.

Hosted macOS CI temporarily runs `npm run smoke:macos:ci`, excluding terminal presentation, and
does not run capacity while the observed macOS presentation-readiness and native PTY teardown
flakes are hardened. The full `smoke:macos` command remains the macOS pre-push check, capacity
remains locally runnable, and quantitative plus deterministic capacity evidence is owned by the
controlled path below rather than GitHub-hosted runners.

## Controlled quantitative gate

Run the quantitative budgets only on a maintainer-controlled supported machine:

```sh
npm run performance:capacity
```

Use one stable machine and power mode, close unrelated high-load applications, leave DevTools
closed, and avoid concurrent builds or test runs. The command refuses a dirty checkout or an
unknown source commit. Run the exact candidate once; do not retry a crossing into a pass. The
evidence record includes the source commit and clean/dirty state, OS/platform release,
architecture, CPU model and logical count, total memory, Node/Electron/Chromium versions, sample
counts and durations, raw CPU series, readiness distributions, and loaded summaries.
Retain that JSON line with the issue, pull request, or release evidence. Compare candidates only
when the recorded environment is meaningfully equivalent; otherwise record a new baseline rather
than treating unlike machines as one distribution.

The controlled scenario first compares three 30-second Electron renderer-plus-GPU CPU samples
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
Delivery buffers are capped at 64 KiB; visible output flushes on the next frame and hidden output
within 40 ms. Every mode fails when delivery is not coalesced, a buffer exceeds its cap, hidden
presentation advances, a PTY is orphaned, or all terminals cannot recover with Changes and
History usable. Controlled mode additionally fails when the idle CPU median ratio exceeds 1.5,
loaded launch p95 exceeds twice baseline, an individual loaded launch exceeds one second, p99
latency is >=100 ms, an unexplained stall exceeds 500 ms, net loaded-interval working-set growth
exceeds 256 MiB. Ghostty scrollback is bounded to 10 MB per terminal.

## Focused parsing and reflow investigation

`HVIR_CAPACITY_REFLOW=1 npm run smoke:capacity` extends this same scenario for #775.
It fills the selected terminal's existing 10 MB retained buffer with 120,000 long lines
containing CJK, combining accents, and supplementary-plane emoji, verifies a retained search,
then runs the ordinary visible/hidden mixed-output interval while alternating the window's
content width between 1100 and 1300 pixels at height 800. Twelve changes use two-second
spacing. Hidden panes retain their normal fit suppression. The original ASCII retained-search
contract still runs after load. No product execution or scheduling behavior changes.

The additional `[smoke:capacity:reflow]` record reports all twelve elapsed samples,
observed terminal columns, and p50/p95/max. These timings run from main's resize request
until the renderer reports changed terminal columns; they include OS/window layout, IPC,
fit scheduling, native resize, and measurement polling. They are **not** native-operation
timings or confirmation of completed canvas paint. Polling resolution is 20 ms plus IPC;
the existing frame/click, exact-input-echo, process-memory, and delivery-buffer evidence
remains separately labeled. No Long Tasks or Event Timing observer is installed.

Each readiness report also separates input-to-response latency from launch-to-echo:
`inputResponse` records main's first synthesized key dispatch through the supervisor's
observation of the exact PTY echo, using the existing subscription and ten samples.
It reports p50/p95/max at millisecond clock resolution and excludes subsequent renderer
parsing and paint. No additional PTY or polling loop is introduced for this measurement.

Use clean known commits, identical artifact pins, geometry, load, machine, and power mode
for comparisons. Run builds before measuring and avoid concurrent tests or builds. Record
the fork release provenance (source, upstream, Ghostty commits and tarball SHA-256), local
WASM SHA-256, machine and power settings alongside the existing source/environment JSON.
Record Linux and macOS separately; exploratory or unavailable environments cannot establish
a controlled performance verdict. `HVIR_CAPACITY_REFLOW=1 npm run performance:capacity`
uses the same extension with the existing quantitative gate.

Main bounds each geometry read to five seconds and restores window size after the sequence
or failure. The existing scenario launcher owns the finite process timeout and process-tree
termination outside the renderer. A killed renderer supplies no in-process cleanup proof.
Execution alternatives and detailed engine instrumentation belong in isolated experimental
worktrees; retain their exact commits and measurement overhead in the issue, and do not
promote them into the production adapter or dependency pin through this procedure.

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
Treat monotonic post-warmup growth, a renderer crash/OOM, or scrollback exceeding the 10 MB
per-terminal bound as a failure and retain the sample table with the release evidence.

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
