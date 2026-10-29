# Native Ghostty: matched probes and interactive scrolling

Continuation of [#1091](https://github.com/jarmak-personal/hvir/issues/1091), under
[#1090](https://github.com/jarmak-personal/hvir/issues/1090). The [initial study](initial-study.md)
proved native Metal/IOSurface delivery into sandboxed Electron. This continuation adds matched
numerical workloads, exact text checks, and a persistent scrolling demo.

**Recommendation remains proceed conditionally.** The native feed API is substantially faster
in these small workloads, but scheduling observations are mixed. These results do not establish
a GPU-caused speedup, improved physical presentation latency, or production readiness.

## Run the demo

From this worktree, with locked dependencies installed:

```sh
# Persistent native demo, using a bridge already compiled by build.sh:
node scripts/native-ghostty-qualification/run.mjs demo native /absolute/path/to/bridge.node

# The same replay-only demo with the exact installed ghostty-web:
node scripts/native-ghostty-qualification/run.mjs demo web
```

Both seed 3,000 synthetic agent/git/build/test lines and start with output paused. Wheel or
trackpad-scroll over the terminal; use Top/Bottom, PageUp/PageDown, Home/End, width toggle, or
start/pause output. There is no interactive shell or hvir session attached. The window stays
open until closed; it no longer quits after 13 seconds. The shared desktop smoke lock remains
held until close, so close the demo before running desktop acceptance checks.

Both use Menlo 14, 100×30 cells and a fixed 2× native scale. To match the browser canvas on the
recorded host, native Ghostty uses explicit `adjust-cell-width = 1` and
`adjust-cell-height = -3` physical-pixel overrides; web uses `smoothScrollDuration: 0`.
These are experiment settings, not unmodified Ghostty or hvir defaults. The recorded canvases
are both 1800×900 physical pixels. Monitor/DPI migration and complete terminal input/selection
behavior are outside this demo.

If needed, build the pinned native bridge first, using absolute paths:

```sh
bash scripts/native-ghostty-qualification/build.sh \
  /absolute/path/to/ghostty /absolute/path/to/zig-0.17.0/zig /absolute/path/to/node/headers
```

The script prints its fresh temporary directory and `bridge.node` path. It reads the Ghostty
clone, archives the exact v1.4.0 commit, applies the experiment patch, and builds in scratch.
It does not install an engine into hvir or edit the supplied clone. Close cleanup destroys the
receiver, waits for texture leases, frees native resources and the disposable idle process,
and removes the runner's temporary config/user-data directory. Build scratch and result
artifacts remain for inspection and can be removed explicitly afterward.

## What was checked

The common runner drives both engines with identical bytes, grid changes, workload order,
warmup and settling phases. It reuses bounded concepts from
`src/main/smoke/capacity-output-fixtures.ts`, `capacity-terminals.ts`, and `capacity-reflow.ts`;
it does not run their full 12-terminal topology or the unchanged hvir gauntlet against native.

| Probe | Fixed input / assertion |
| --- | --- |
| Plain / ANSI / synchronized bursts | 2,000 numbered lines each; exact retained plain text, including ANSI removal and synchronized-mode output. The synchronized mode opens and closes in the same burst; this does not prove held-frame suppression. |
| Unicode retained and reflow | 400 numbered rows containing `界é🙂` repeated 24 times; exact complete retained text before and after 100→72→110→100 columns, preserving combining and wide characters. |
| Scrollback and wheel | 500 colored rows; exact retained contents, earliest/latest viewport markers, positive wheel moves down, negative wheel restores the original viewport, and all retained text survives scrolling. |
| Paced output | 100 batches of ten lines at a nominal 16 ms period; exact final retained text plus raw draw-notification intervals. |
| Persistent demo | All 3,000 rows match expected text; real Electron wheel input moves the native viewport from row 0 to row 20. Reviewed [before](interactive-top.png) and [after](interactive-scrolled.png) screenshots show it. |

There are ten exact text checks per measured process, plus scroll-direction/restoration checks.
All 60 exact checks passed across six measured processes. SHA-256 inputs/expected/observed
values and raw timing arrays are embedded in [comparison.json](comparison.json). The
[interactive native proof](interactive-native.json) independently verifies 3,000 retained rows,
first/last markers, actual Electron wheel input, and release of all eight exported textures.
The [web interactive proof](interactive-web.json) exercises the equivalent demo.

Normalization removes terminal padding at line ends and empty trailing screen rows only;
fixtures contain no intentional trailing whitespace. Exact text checks do not prove ANSI color,
selection identity, or all reflow/provenance semantics. Text readback and hashing occur outside
the timing intervals. Raw fixture bytes are generated from the retained workload source; logs
contain numerical samples and hashes rather than arbitrary terminal transcripts.

## Numerical observations

Recorded host: Apple M2 with 8 GPU cores, macOS 15.7.3 (24G419), built-in Retina display at
60.0024 Hz and scale 2; Electron 43.8.1 / Chromium 150.0.7871.250. Native uses Ghostty v1.4.0
`83fb95624b0439ee660c2679b43b38c8b63769cd`, Zig 0.17.0 ReleaseFast and the experiment patch.
Web uses the exact installed `hvir-v0.4.0-20` artifact (`18fc0d2bddb0c788ef5f1c58464603bd20d1c391`),
whose Ghostty core is the earlier 1.3.1 revision `332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28`.
This is a candidate-versus-incumbent comparison, not an isolated rendering-backend experiment.

Three fresh processes per engine ran sequentially in counterbalanced order: native/web,
web/native, native/web. No repository builds or tests ran concurrently. Each process performs
two 300-line warmup rounds before measured phases. This is exploratory local evidence from
three repeats, not a controlled-machine performance gate or a statistical latency guarantee.

The table shows median milliseconds across three repeats:

| Burst | UTF-8 bytes | Native API service | Web API service | Native caller round trip | Web caller round trip | Native next draw scheduling ack | Web next draw scheduling ack |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain | 82,000 | 0.268 | 1.9 | 0.6 | 1.9 | 14.3 | 12.6 |
| ANSI | 98,000 | 0.405 | 2.5 | 0.6 | 2.5 | 13.3 | 12.1 |
| Synchronized | 96,016 | 0.258 | 1.5 | 0.5 | 1.5 | 13.3 | 12.8 |
| Unicode | 102,800 | 1.042 | 6.6 | 1.8 | 6.6 | 26.2 | 26.7 |

Timing meanings matter:

- **Native API service** times `Termio.processOutput` inside the C bridge, including its lock
  and render-queue work, excluding IPC, UTF-8 buffer creation, GPU render/copy and presentation.
  **Web API service** times the installed synchronous `Terminal.write`, including WASM parsing
  and surrounding JavaScript terminal maintenance. It excludes subsequent Canvas rendering.
- **Caller round trip** is measured in the common renderer around the awaited write. Native
  includes IPC and main-process buffer creation; web calls its local API directly.
- **Next draw scheduling ack** starts after the write returns and ends after a subsequent
  renderer draw notification and rAF scheduling acknowledgment. A prior pending frame may
  satisfy this observation; no output-generation/content tag proves causal completion of the
  specific burst. It is not visible-pixel latency or a presentation fence.
- Native service uses a monotonic nanosecond clock; browser timers have coarser resolution.
  Small differences and three-sample percentiles must not be treated as precision guarantees.

Native service medians are roughly six to seven times faster here. The native core version,
ReleaseFast native build, WASM build, and different API responsibilities confound that result.
**It is not evidence that GPU rendering caused those gains.** End-to-end scheduling does not
show a comparable general improvement.

| Scheduling observation | Native | Web |
| --- | --- | --- |
| Resize API through next draw scheduling ack, 9 samples | Median 31.4 ms; range 31.3–48.2 | Median 24.3 ms; range 23.3–26.3 |
| Wheel dispatch through next draw scheduling ack, 6 samples | Median 13.95 ms; range 8.3–23.3 | Median 16.25 ms; range 14.2–46.5 |
| Paced draw intervals, per-run p50 | 15.4 ms | 16.7 ms |
| Paced draw intervals, per-run p95 | 20.4–20.5 ms | 17.0–17.4 ms |
| Paced draw intervals, per-run p99/max | 20.5–20.6 ms | 33.4–33.7 ms |

The resize interval stops before exact text readback/hashing. Native waits for a newly drawn
frame with the requested dimensions, which are recorded (1296×900, 1980×900, 1800×900).
This covers those observed transitions, not resize-generation safety or rejection of every
stale completion. Wheel timing excludes the common 200 ms settling wait before viewport
readback. Synthetic DOM wheel events drive matched numerical checks; the separate interactive
proof uses actual `webContents.sendInputEvent` delivery.

Pacing observations are mixed: native has the higher p95 but fewer long tail gaps in these
runs. Native and web notification hooks also observe different points in their pipelines.
Neither p95 nor p99 alone establishes a pacing winner. Polling the native export every 4 ms,
IPC, the synchronous export GPU blit, native rendering, and Chromium scheduling are plausible
sources of candidate overhead. Their individual causal contribution was not instrumented.
No high-refresh, physical input-to-pixel, or native Ghostty GUI reference was measured.

Native measured runs sent/released 138/138, 138/138 and 137/137 textures, with zero held at
teardown. Browser runs dispose their terminal by destroying their isolated window. This is
bounded-run cleanup evidence; crashes, long-lived stress, and production multi-session
lifecycle remain separate work.

The frozen six-process numerical schedule was collected with candidate
`0d1a0048a83421d0b8a91da131b92d031b62c1c6`. Subsequent review corrections add configuration
diagnostic/pixel-geometry guards, restrict native actions to the four scrolling bindings,
and expose the existing interactive proof through an explicit CLI mode. They do not change
the timed workload or API timing boundaries. Interactive proof artifacts were regenerated
through the supported probe commands after those corrections.

## Reproduce the comparison

```sh
node scripts/native-ghostty-qualification/run.mjs compare \
  /absolute/path/to/bridge.node /absolute/path/to/a/new/results-directory
```

The output directory must be new. All six scheduled processes run sequentially, without retries;
a failure makes the aggregate fail. Per-process JSON files and the aggregate `comparison.json`
are written there. The committed aggregate embeds all raw per-run values; its `artifact` names
identify the separate files that reproduction also writes. Keep other desktop workloads,
builds and tests quiet during collection. Do not use this exploratory run as a release budget.

Reproduce the bounded interactive wheel proof and its screenshots separately:

```sh
node scripts/native-ghostty-qualification/run.mjs probe native \
  /absolute/path/to/bridge.node /absolute/path/to/new/native-probe-results
node scripts/native-ghostty-qualification/run.mjs probe web \
  /absolute/path/to/new/web-probe-results
```

Each probe verifies complete seeded retention, sends real Electron wheel input, records
`probe.json`, captures `viewport.top.png` and `viewport.scrolled.png`, then closes and cleans up.
Use `demo` for the persistent hands-on window. Configuration diagnostics or unexpected pixel
geometry fail explicitly rather than silently collecting an unmatched comparison.

The current eight-file upstream patch is an issue-authorized reproduction artifact against
pinned external source, not an alternate repository home for executable bridge source.
`bridge.c` is separately retained under the ordinary maintained-C policy. The additional
`src/termio/Exec.zig` patch recognizes only the exact disposable `/bin/sleep 86400` command and
executes it directly, bypassing macOS `login(1)`. An initial failed interactive check revealed
an asynchronous “Last login” row; the corrected run verifies all 3,000 rows exactly. No user
`.hushlogin` file was created and no ambient bytes are filtered away. This remains an idle
exec backend, not a complete external transport integration.

The patch was reapplied to a fresh v1.4.0 archive; all eight resulting source files matched the
successfully built source byte-for-byte. Earlier local-PTY and artificial three-consumer-delay
observations belong to the [historical harness](initial-study.md), not this runner's phases.

Production ownership, clipboard/link/session authority, Linux DMA-BUF compatibility, P3/alpha
fidelity, driver coverage, packaging and a focused embedding facade remain the risks identified
in the initial study. This continuation proposes no user-visible hvir change and changes no
production terminal owner, normal startup, installation, packaging, ADR or source policy.
The next decision is which native presentation/process path to qualify further, informed by
hands-on feel and matched visible-presentation measurements rather than feed timing alone.
