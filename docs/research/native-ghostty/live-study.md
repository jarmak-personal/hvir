# Live native Ghostty qualification (#1094)

**Provisional macOS recommendation: proceed to migration scoping with explicit gaps.** The macOS
experiment now has a real hvir-owned PTY path, independent native surfaces, bounded
GPU leases, and repeatable lifecycle evidence. This is enough to justify designing
the migration. It does not qualify Linux or establish complete harness compatibility.
No production engine, dependency direction, or ADR replacement is selected here.
The maintainer separately decides whether to authorize that next scope. #1094 remains
open pending the maintainer-run Linux desktop attempt described below.

## Try it

Use the child PR's exact pushed head (or its integrated epic commit), not an
uncommitted local variant. `git rev-parse HEAD` records the reproduction identity.
Linux testing must use a pushed source commit; macOS native artifacts cannot be
copied to Linux.

On Apple Silicon macOS, after `npm ci`, build from a clone containing the pinned
Ghostty 1.4.0 commit using Zig **0.17.0** and a directory containing `node_api.h`:

```sh
bash scripts/native-ghostty-qualification/build.sh \
  /absolute/path/to/ghostty /absolute/path/to/zig-0.17.0/zig /absolute/path/to/node/headers
```

Set `qualification_bridge` to `bridge.node` in the experiment directory printed by
the build. That directory must remain present: its dylib is loaded through rpath.

```sh
qualification_bridge=/absolute/path/to/experiment/bridge.node
node scripts/native-ghostty-qualification/run.mjs live "$qualification_bridge" plain-shell
node scripts/native-ghostty-qualification/run.mjs live "$qualification_bridge" claude-code
```

Run one demo at a time. Each starts in a newly created disposable workspace. The
Claude demo uses the bundled provider's launch semantics, including its new session
UUID and login-shell environment; it does not copy Claude flags into the experiment.
The maintainer controls trust approval and all live prompts. Account/configuration
and any provider-owned persistence follow the existing provider environment.

Click the canvas to type. Control/navigation keys, wheel scrolling, explicit
Cmd+V text paste, mouse press/release, and width controls are connected. The Top and
Bottom buttons operate terminal scrollback; a harness's own transcript/TUI scrolling
may instead consume mouse or key input. IME, text selection, search, image paste,
links, titles/attention integration, full keyboard-layout mapping and complete mouse
semantics are **not implemented**. Dragging the host window does not auto-fit the
terminal; the fixed canvas can clip. Use Toggle width for this prototype. This is an opt-in experiment outside hvir's normal
UI.

Closing the demo or Ctrl+C in its launcher terminates the supervisor-owned session,
closes the receiver, drains GPU leases, frees Ghostty, and removes the owned temporary
workspace/config/user-data and generated launcher. External harness account state is
not removed. Keep the separate native build directory for another run; remove it only
when no demo is using it.

For repeatable fixed-command checks, choose a new output directory for each command:

```sh
node scripts/native-ghostty-qualification/run.mjs live-probe "$qualification_bridge" /tmp/hvir-live-run-1
node scripts/native-ghostty-qualification/run.mjs resize-probe "$qualification_bridge" /tmp/hvir-resize-run-1
node scripts/native-ghostty-qualification/run.mjs harness-probe "$qualification_bridge" /tmp/hvir-harness-startup
node scripts/native-ghostty-qualification/run.mjs compare "$qualification_bridge" /tmp/hvir-matched-live-study
node scripts/native-ghostty-qualification/run.mjs probe native "$qualification_bridge" /tmp/hvir-replay-native
node scripts/native-ghostty-qualification/run.mjs probe web /tmp/hvir-replay-web
```

`harness-probe` launches Claude without submitting a prompt, observes startup, then
cleans up. `live-probe` runs two fixed raw-PTY peers and exits. The live study scheduled
three fresh processes, retained every result, and used no automatic retries. The
existing comparison still runs six counterbalanced native/web processes. All desktop
experiments use the existing smoke lock; a persistent demo holds it until closed.

## Evidence and limits

Hardware/settings match the [first study](README.md): Apple M2, 8 GPU cores,
macOS 15.7.3 (24G419), approximately 60 Hz Retina at scale 2, Menlo 14 with the same
explicit cell adjustments, 100×30 / 1800×900 initial geometry. Electron 43.8.1 /
Chromium 150.0.7871.250; native Ghostty 1.4.0 at
`83fb95624b0439ee660c2679b43b38c8b63769cd`, Zig 0.17.0 ReleaseFast. The installed
web artifact remains hvir-v0.4.0-20 / fork `18fc0d2bddb0c788ef5f1c58464603bd20d1c391`,
with Ghostty core 1.3.1. Version/build/API differences still confound GPU attribution.

[Raw live runs](live-evidence.json) contain every timing sample, stream digest,
check and resource count. Three of three runs passed all **37 checks**:

- Each real PTY peer received exact DSR cursor replies, typed text, Ctrl+A, Up,
  Enter and Unicode bracketed paste. SGR mouse press/release reached each peer;
  this checks the protocol shape, not a comprehensive coordinate/drag matrix.
- Independent A/B surfaces each retained exactly 2,000 ordered rows and their
  complete distinct 74,000-byte wire workload. The final fixed peer uses NEL
  rather than LF to avoid PTY output-line-discipline rewriting. The attachment
  passes received bytes synchronously into Ghostty; it has no presentation queue
  that can discard or reorder them. Binary/non-UTF-8 stream handling remains
  unqualified because the existing LocalHost PTY API delivers decoded strings.
- Alternate-screen entry/exit and session-qualified text passed independently.
  B received its full output while hidden. Reveal requires a receiver acknowledgement
  whose serial exceeds the producer's pre-reveal completed-frame barrier in the
  current receiver generation; a historical rAF acknowledgement cannot pass. A real
  Electron wheel event changed the native scrollback viewport.
- Six rapid grid/PTY resizes preserved retained text and ended at a previously
  unrequested 96×30 / 1728×900 size. A later receiver acknowledgement must exceed
  the pre-resize producer serial barrier, match that size and the current receiver
  generation, and carry the latest delivery geometry epoch (7 in these runs).
  This is a delivery tag, not a native content-generation fence; intermediate
  reused dimensions and causal content-to-pixel latency remain unmeasured.
- Stop refused while Chromium owned a texture. Destroying A's delayed receiver
  released all its imports, preserved the PTY and terminal state, and allowed a
  new receiver generation to draw. Closing B terminated only B's PTY, and A then
  round-tripped fresh input through its real PTY and redrew after B's native app was freed. Sender and
  document-generation checks reject obsolete IPC; native callbacks carry their
  own surface userdata. Native-surface recreation, crash recovery, long-duration
  stress and cross-process native hosting remain untested.

Each surface owns three export slots and a 65,536-byte reply FIFO. A intentionally
held receiver references for 100 ms. Its maximum outstanding leases was three;
B's was one. A dropped 7, 8 and 8 obsolete frames while all workload bytes and
text remained intact. There were no GPU-copy errors or reply overflows.

| Run | A imports / releases | B imports / releases | Held after teardown |
| --- | --- | --- | --- |
| 1 | 12 / 12 | 8 / 8 | 0 |
| 2 | 14 / 14 | 9 / 9 | 0 |
| 3 | 14 / 14 | 11 / 11 | 0 |

The raw `revealProof`, `resizeProof` and `survivorProof` retain each producer barrier,
current receiver generation, observed serial/dimensions and delivery epoch. For
example, final-resize barriers 9, 9 and 10 were followed by acknowledged serials
10, 10 and 11 respectively, all at 1728×900 and epoch 7. These supersede the earlier
loose reveal/resize predicates, which could accept historical acknowledgements.
They prove later completed-frame delivery, not content-correlated physical display.

An imported frame can be released after receiver destruction without a successful
send. Import/release counts, successful sends and draw acknowledgements are separate
facts. Electron logged its reclamation of dangling renderer references during this
intentional destruction. Both supervisor-owned PTY child PIDs and both retained
Ghostty idle child PIDs were absent after cleanup in all three runs; registry removal
alone was not used as evidence of process exit. Descendant process trees and SIGKILL
cleanup are not qualified.

[Development failures](live-development-failures.json) remain available. Early raw
stream expectations incorrectly assumed LF output was byte-identical through the
macOS PTY: ONLCR adds CR, and the observed stream also contained extra CR at some
output boundaries. A CSI next-line replacement then failed because it clamps at the
bottom instead of scrolling. The final NEL fixture avoids those newline transformations
and preserves the same row workload. These were corrected fixture assumptions before
the scheduled three-run series, not retries relabeled as passing measurements.

[Claude startup](harness-startup.json) records a real **Claude Code 2.1.309** launch
through the existing provider/supervisor/LocalHost path. Its retained startup text
contained the title and workspace trust prompt; three explicit assertions passed,
including a subsequent completed-frame acknowledgement in the current receiver.
All 9 imports were released, the PTY and idle child exited, and no model
prompt or trust approval was automated. Input/reply checks above use the fixed PTY
peer. They do **not** prove Claude's full composer, model-turn behavior, or transcript
scrolling beyond the trust screen. Those remain maintainer hands-on checks using the
live command. The earlier maintainer observation that native scrolling felt much
smoother/faster remains positive qualitative macOS evidence, separate from timings.

## Width-toggle correction

The maintainer's live Claude use found scrolling, typing and general feel great, but
Toggle width left the harness display wrong. Dragging the window was also tried;
window auto-fit is an independent unimplemented prototype gap, not the toggle bug.
This is qualitative live-harness feedback, separate from measured performance.

The bug was in this experiment's external IO ordering. Ghostty's public Surface grid
changes immediately, while its IO thread normally coalesces parser resize for 25 ms.
The experiment notified the real PTY immediately. Its SIGWINCH redraw therefore
arrived while Ghostty still parsed with the old dimensions. Upstream normally holds
the parser's lock while resizing its own PTY and parser; the external path had skipped
that ordering invariant. Production supervisor/LocalHost forwarding was correct and
has not changed.

[Pre-fix evidence](resize-before.json) retains 30/50 direct API ordering mismatches:
9/10 in the first ten probes, 21/40 in the remaining probes (not a formal startup
readiness boundary). The same real-PTY peer received all six changed-width SIGWINCH
notifications. On all three narrow toggles, kernel `stty size` and Node stdout said
80 columns, but Ghostty reported 100 / 1800 pixels, clamped at column 100 and wrapped
at row 3/column 82 instead of row 4/column 2. Startup and the three wide cases passed.
This detects incorrect parser state, not a missing resize call or a guessed Claude bug.

The private patch now sends a ticketed resize through the IO thread, clears older
pending coalesced work, applies parser state, then acknowledges that exact ticket and
geometry. Main notifies the supervisor only for the latest matching applied ticket.
The initial native ticket applies before PTY spawn. Repeated equal sizes cannot reuse
an old acknowledgement; close revokes pending notification. No arbitrary production
delay or cosmetic repaint was added. Both live and replay runners validate applied
geometry/failure state. Fresh live samples name the immediate request boundary
`nativeResizeRequestMs`; it does not time actual PTY notification.

[Fixed real-PTY runs](resize-evidence.json) scheduled three fresh processes without
retries: all **33 checks** and **27 peer records** passed, including **18 actual
Electron Toggle width button clicks**. Kernel size, stdout resize/SIGWINCH, CSI 18t
cells, CSI 14t pixels, cursor clamping and immediate redraw/wrap agree after every
change. Rapid request tickets 8–11 notified only ticket 11 even after returning to
100 columns. A delayed observation beyond the known 25 ms timer checked that older
coalesced work did not restore stale state; the delay is a regression observation
window, not resize readiness. Closing with ticket 12 pending allowed native completion
but no late PTY notification. These are fixed-peer correctness results; they do not
claim physical display latency or a completed maintainer retest of the full harness.

To reproduce the pre-fix manual path, use the old `5aea3deb` live shell/bridge and run
the current `resize-fixture.mjs` as a fixed command in that shell, then click Toggle
width. It uses the same size-query/redraw peer; the raw before/after records preserve
the comparison. Rebuild the native bridge for the corrected live command above; the
old binary deliberately lacks the new applied-ticket API.

## Responsiveness comparison

[New matched raw samples](live-comparison.json) rerun the established workloads
against the ticketed-resize bridge and installed web artifact: all **60 exact-text checks**
passed, as did geometry and scrolling assertions. The supported 3,000-row replay
probes also passed for [native](live-replay-native.json) and [web](live-replay-web.json).
These are standalone engine comparisons using hvir's installed web artifact, not a
native replacement running the whole hvir performance gauntlet.

Median milliseconds, three processes per engine:

| Observation | Native | Web |
| --- | ---: | ---: |
| Plain 82 kB API service | 0.251 | 1.9 |
| ANSI 98 kB API service | 0.409 | 2.4 |
| Synchronized 96,016 B API service | 0.242 | 1.6 |
| Unicode 102,800 B API service | 0.975 | 6.5 |
| Plain caller round trip | 0.6 | 1.9 |
| ANSI caller round trip | 0.7 | 2.4 |
| Synchronized caller round trip | 0.6 | 1.6 |
| Unicode caller round trip | 1.5 | 6.5 |
| Resize through next draw scheduling acknowledgement (9 samples) | 31.5 | 24.8 |
| Wheel through next draw scheduling acknowledgement (6 samples) | 9.7 | 18.8 |

Native service times `Termio.processOutput`; web wraps `Terminal.write` and its
JS/WASM maintenance. Native caller time adds IPC and encoding; web runs locally.
Exact readback/hashing happens outside timers. The next scheduling acknowledgement
can come from an already pending frame: it is not causal workload-to-visible latency.
The private IO path differs from the historical eight-file/coalesced-resize build;
these are refreshed samples, not the earlier measurements relabeled. A replay failure-
metadata guard was added after collection without changing successful readiness or
timing boundaries; the supported native replay probe passed with that guard.
No hardware display fence, content-tagged frame, high-refresh reference, or physical
input-to-pixel measurement was added. Native Ghostty GUI was not available as a new
controlled reference run. The older GUI comparison is the maintainer's observation.

Native paced-output per-run draw p50 was 15.4 ms, p95 20.4–20.5 ms and p99/max
20.5–21.8 ms. Web p50 was 16.7 ms, p95 17.0–18.7 ms and p99/max 33.0–33.8 ms.
Resize favoured web; wheel scheduling favoured native in this sample. These mixed
observations support neither a blanket pacing win nor a physical latency claim.

The two-live-surface runs also observed main and renderer scheduling under their
short fixed workload. Main 4 ms timer p95 was 5.21–5.24 ms, p99 7.30–9.49 ms,
max 21.25–26.16 ms. Renderer rAF p95 was 18.6–18.7 ms, max 18.7–19.0 ms.
Synchronous feed calls for the roughly 1 kB PTY chunks had per-run p95
0.021–0.025 ms and maxima 0.059–0.609 ms. These samples include setup/interaction
phases, deliberate receiver delay and window changes. They show bounded observed
service on this small case; they do not qualify workbench responsiveness or sustained
large-output/capacity behaviour. Parsing still runs in Electron main in the prototype.

## Linux and SSH

**Linux GPU readiness is unresolved; desktop result pending.** The maintainer will
run the pushed branch on a Linux desktop. No Linux environment was available to this
Mac agent; discovered SSH aliases were not assumed disposable, and no local Docker
daemon was available. No Linux build, descriptor-transfer, GPU import, driver or SSH
byte-path result is claimed. Keep #1094 open until the desktop result is assessed.

The macOS bridge and `build.sh` remain Darwin/arm64-only. Use the separate Linux-native
build/embed-boundary kit below. It deliberately does not present the macOS bridge as
a Linux importer. It selects the four portable embedded/Termio/Thread/message file patches from the
one authoritative pinned patch, leaving Darwin build, Metal and MSL changes unapplied.

Fetch the published child branch and use the **exact pushed head SHA from its PR
handoff**; the command records that SHA in `source-commit.txt` and `result.json`.
Before integration the branch is `agent/issue-1094`; after integration the same source
is also retained in `epic/1090-native-ghostty`.

```sh
git fetch origin agent/issue-1094
git switch --detach origin/agent/issue-1094
git rev-parse HEAD
bash scripts/native-ghostty-qualification/linux-attempt.sh \
  /absolute/path/to/ghostty /absolute/path/to/zig-0.17.0/zig /tmp/hvir-linux-attempt-1
```

Use a new output directory. Prerequisites are Node 24+, Git, a C compiler, standard
Linux/coreutils tools including `timeout`, and Zig 0.17.0. The Ghostty clone must
contain the pinned 1.4.0 commit. Native dependency or compiler failures remain in the
build log; the kit does not install system packages or mutate the supplied clone.
`eglinfo` is optional. This focused native attempt does not need Electron or macOS
artifacts. Run `npm ci` separately before ordinary repository verification.

The kit builds platform-specific artifacts on Linux with:
`zig build -j2 -Dapp-runtime=none -Demit-lib-vt=false -Demit-docs=false
-Demit-themes=false -Doptimize=ReleaseFast --prefix <owned-output>/native`, bounded to
15 minutes. If the library builds, it compiles a small C probe and runs it for at most
30 seconds against `native/lib/ghostty-internal.so`. Environment evidence records
kernel, CPU, DRM device/driver IDs, display system and available render nodes. Logs
retain optional EGL information, compiler output and native initialization output.

The source limitation is announced **before** the runtime call: this pinned API
exposes only macOS/iOS. If native app initialization succeeds, the probe checks the
rejection of a deliberately **unsupported** tag 3. That confirms a known embedding
API boundary; it is not a newly discovered GPU/driver failure. The expected shared library is checked before loading: pinned `build.zig:234`
installs `ghostty-internal.so` for non-Darwin/non-Windows targets. A missing artifact
is reported separately. Runtime exit codes distinguish library loading (10), global
initialization (11), config allocation (12), app initialization (13), and missing ABI
symbols (14); code 3 confirms the known platform boundary. No cause is inferred from
a shared generic initialization error. The library stays
mapped until process exit because this ABI exposes no global shutdown operation.
No surface, frame or descriptor-transport success is inferred from app initialization.

The attempt exits nonzero even when that expected boundary is confirmed. Return
`result.json`, `build.log`, and, if created, `runtime.log`, `cc.log`, `egl.log` and
`versions.log`. A native build failure is useful evidence and must not be retried
unchanged until it happens to pass. Classify the first concrete boundary, then decide
whether a focused correction is warranted. The current command is **not a Linux
Electron scrolling demo**: an EGL embedding facade, DMA-BUF export/lease handling and
Electron import path still need a real Linux experiment. No CPU fallback qualifies it.
The Linux build/runtime command has not been executed here; local checks cover shell
syntax, C syntax against the pinned header, patch extraction/application and evidence
serialization and the portable loader-failure exit code on macOS only.

Pinned source provides useful leads only: `OpenGL.zig` exports DMA-BUFs when the
runtime can present them; `opengl/Frame.zig` synchronizes with `gl.finish()`. The
embedded runtime still represents macOS/iOS platforms. A future native run must record
fourcc, plane offsets/strides, modifiers, synchronization and FD duplicate/close counts
on both producer and Electron sides. All Mesa/NVIDIA, Wayland/X11 and multi-GPU cases
remain untested. No new SSH attachment or tmux persistence policy was introduced;
#1080/#1086 retain that ownership.

## Demonstrated patches and remaining design risks

[Patch reproduction](patch-reproduction-live.json) proves that the final upstream
patch applies to a fresh pinned archive and all ten resulting files match the
actually built source byte for byte. Bridge source has its own recorded digest.
The prior single-surface replay commands remain supported.

| Upstream seam | Demonstrated change |
| --- | --- |
| `build.zig`, `build/GhosttyLib.zig` | Install the Darwin dylib and explicitly link Metal. |
| `build/SharedDeps.zig`, `renderer/metal/shaders.zig` | Same experimental runtime compilation of unchanged MSL; no production toolchain choice. |
| `renderer/Metal.zig` | Completed IOSurface callback carries the owning surface userdata. |
| `apprt/embedded.zig` | Manual feed and per-Termio callback context. |
| `termio/Termio.zig` | Intercept writes at the owning IO instance; replaces the old global backend-only hook. |
| `termio/Thread.zig`, `termio/message.zig` | Ticketed external resize on the IO thread, superseding older coalesced work before acknowledging parser geometry. |
| `termio/Exec.zig` | Retain the exact idle sleep fixture without login output/bookkeeping. |

There are two fixed wrapped C session objects, each with its own Ghostty app/surface,
reply FIFO, Metal copy queue and export pool. This demonstrates independent routing
and removes the callback's single-surface assumption. It **does not remove the idle
exec backend**: two extra idle processes remain while two surfaces are live. A real
external backend and an appropriate app/device-sharing model are still design work.
Ten touched upstream files are a demonstrated patch footprint, not a forecast of
the final patch size or maintenance schedule.

Completed Ghostty textures are still copied by a GPU blit into independently leased
IOSurfaces. The completion thread waits for that copy before upstream reuses its
source. There is no routine CPU pixel readback in this path. Electron imports in main;
a sandboxed, context-isolated preload consumes a VideoFrame into Canvas2D and releases
it. A dedicated native host would require actual Mach-port/FD transfer, crash/exit
handling and a selected synchronization/lifetime protocol. Serializing pointer bytes
or FD integers over ordinary JSON IPC is insufficient. Parsing in main and the export
copy wait are still reasons to evaluate process/thread placement before production.

The experiment alone imports production launch/host/provider ports. Shared contracts,
viewer/Git, normal startup and packaging do not import the experiment; no production
source changed. The live entry point owns its narrow experiment lifecycle, receiver
and IPC orchestration; the PTY adapter owns supervisor/host lifetimes; the fixed peer
and probe own disposable evidence. Source budgets/dependency checks stay unchanged.
No ADR change is required until a durable production design is chosen.

Clipboard reads from the terminal engine remain unavailable, and native terminal
clipboard writes are ignored; no OSC 52 authority is added. Explicit Cmd+V reads text
only for the current verified demo sender/session/generation, with a 65,536-byte bound.
Links are not activated. The production clipboard/link/replay policies remain later
integration work; this study makes no complete parity claim. The minimum useful next
decision is whether this macOS evidence plus the explicit Linux and harness gaps
justifies full migration scoping. It does not authorize more migration children.
