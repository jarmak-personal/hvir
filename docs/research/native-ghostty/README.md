# Native Ghostty qualification

Qualification for [#1091](https://github.com/jarmak-personal/hvir/issues/1091), under
[#1090](https://github.com/jarmak-personal/hvir/issues/1090). Recorded 2026-10-28.
This report is evidence for a migration decision, not a selected production architecture.

**Recommendation: proceed conditionally with a small integration design and Linux presentation
qualification.** Native Ghostty terminal pixels reached a sandboxed Electron window on macOS.
The experiment substantially reduces uncertainty about the presentation bridge. It does not
establish a fluidity improvement over current hvir, qualify Linux, or establish production parity.
Keep the epic open. Agree the next work boundaries after reviewing these findings.

## What ran

| Input | Recorded value |
| --- | --- |
| hvir base | `54e3e43489808a51b0003590555ded846a548783` |
| Ghostty | v1.4.0, `83fb95624b0439ee660c2679b43b38c8b63769cd`, plus [experiment patch](../../../scripts/native-ghostty-qualification/ghostty.patch.txt) |
| Compiler | Zig 0.17.0 aarch64 macOS; Apple clang 17.0.0; Command Line Tools SDK |
| Electron / Chromium | 43.8.1 / 150.0.7871.250, from hvir's locked installation |
| Browser baseline | hvir's installed `ghostty-web` artifact `hvir-v0.4.0-20`, fork `18fc0d2bddb0c788ef5f1c58464603bd20d1c391` |
| Host | macOS 15.7.3, build 24G419; Apple M2, 8 GPU cores, Metal 3 |
| Display | Built-in Retina, 2560×1664 physical; Electron reported 1470×956 logical, scale 2, 60.0024 Hz |
| Native target | 960×600 logical at scale 2, 1920×1200 BGRA pixels; temporary resize to 1600×1000 pixels |
| Native Ghostty GUI reference | Not installed on this machine; no native GUI timing comparison was performed |
| Linux / SSH | No Linux GPU/display environment or configured disposable SSH test target used; source assessment only |

The native path was:

```text
replayed bytes / disposable local PTY
  → existing Ghostty Termio and terminal state
  → existing font/shaping/Metal renderer
  → completed Ghostty IOSurface
  → Metal blit into one of three independently leased IOSurfaces
  → Electron sharedTexture import and send
  → sandboxed, context-isolated preload: VideoFrame → Canvas2D
  → Chromium composition in a visible BrowserWindow
```

There is no per-cell JavaScript rendering in this native path. No application pixel readback is
used for frame transport. A diagnostic `capturePage()` readback produces the screenshot once;
it is outside the presentation path and perturbs timing. The bridge deliberately waits for the
export blit's GPU completion on Ghostty's completion thread before permitting source reuse.
This is a GPU copy with a synchronization wait, not a claim of zero copies or zero stalls.
Chromium's internal copy/readback behavior was not traced.
Color accuracy is also unqualified: Ghostty's Metal target carries Display P3 semantics, while
this export/import probe supplies no explicit color-space metadata. Production must settle
color conversion, alpha/premultiplication, pixel orientation, and scale across both platforms.
The screenshot proves content delivery, not theme/color fidelity.

The window retains `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
The preload draws the received VideoFrame directly; it does not need to pass it through
`contextBridge`. The dummy NSView required by the existing embedder is unattached, so this is
texture composition rather than a native view overlaid on the workbench.

## Observed results

[Native observations](native-observations.json) and [browser observations](web-observations.json)
are retained compact logs. [The captured presentation](native-presentation.png) shows actual
Ghostty-rendered colored text, Unicode, and emoji. Earlier exploratory runs were superseded by
the retained run's corrected scale and post-render GPU-status sample.

| Probe | Observation | What it establishes |
| --- | --- | --- |
| Completed native textures | 563 imports sent, 563 released, zero still held at teardown | The macOS import/receiver/release path ran through actual presentation and shutdown. |
| GPU status after drawing | `2d_canvas`, `gpu_compositing`, and `rasterization` enabled | Hardware-accelerated browser paths were available during the successful run. An early startup sample reports disabled values before GPU initialization and is not the result. |
| Saturated consumer | Hold three consecutive VideoFrames for 150 ms each; seven producer frames dropped, then output resumes | A finite export pool can contain delayed consumption without reusing held textures or accumulating a frame queue. This is not exhaustive fence validation. |
| Resize | Native target resized down and back while the renderer remained live | This simple dimension transition works with the leased pool. Multi-display scale changes and resize storms are unqualified. |
| Hide / show | Window hidden for one second, then shown; terminal resumes presentation | This short visibility transition works. The prototype continues producer work while hidden; production needs a separate presentation policy. |
| Export copy | Last periodic sample: mean 0.710 ms, maximum 1.530 ms | Cost from export reservation through GPU copy completion on this M2, including allocation/encoding overhead. It excludes Ghostty's preceding render and Electron presentation. |
| Local PTY | Native DSR response, `native-input\r`, and `stty size` result `29 99`; child exit 0 | Manual output feeding, actual native-generated replies/input, and explicit resize forwarding can compose with an externally owned local PTY. |

Both isolated renderers approached this display's 60 Hz ceiling during modest sustained output.
For the installed ghostty-web baseline, 584 render notifications occurred during 10.003 seconds
and 8,840 synthetic lines; synchronous `write()` calls totalled about 52.9 ms. The native run
fed output on the same nominal 8 ms / ten-line cadence, with a shorter output phase to allow its
transport probe and teardown. Neither a write return nor a render notification is a display
presentation timestamp. Native draw notifications generally advance at about 60 per second.

**No measurable fluidity win is established here.** These short single runs use different
terminal geometry/default fonts, warmup, deliberate lease delays, hide/show, and a screenshot.
The final native rerun also overlapped repository unit verification, so its timing is not controlled.
Their largest gaps include startup, stress, and idle cursor work and cannot be compared as
latency percentiles. The browser baseline uses the exact installed engine outside hvir's React,
IPC, and terminal-runtime composition. Current hvir's local-platform smoke validates familiar
terminal behavior separately; it does not provide a matched performance comparison. Native
Ghostty GUI and high-refresh reference measurements remain missing. The promising result is
that the native rendering mechanism works; improved feel remains a production acceptance gate.

## Transport and process findings

The external-transport probe is intentionally incomplete. Ghostty still starts one disposable
`/bin/sleep 120` through its existing exec backend, in `/tmp`, and frees it with the surface.
The experiment does not load personal Ghostty configuration. A separate `node-pty` `/bin/sh`
process uses a fixed noninteractive test command and environment. Its output feeds
`Termio.processOutput`; intercepted `Backend.queueWrite` bytes return through a bounded 64 KiB
probe buffer to that external PTY. Overflow fails the experiment. The shell disables echo,
requests a cursor report, receives that report plus native input, prints its resized geometry,
and exits. The successful log records the round trip and exit. No user session is attached.

The write interception bypasses the exec backend but leaves its lifecycle and resize mechanics
present. It is not an external backend implementation: linefeed transformation, subprocess
status, flow control, sustained byte transport, detach/replay semantics, and error propagation
still need design. Production must never drop PTY bytes merely because presentation is slow.
Manual feeding currently runs synchronously on Electron main in this tiny experiment; a real
integration must dispatch bounded input to the native I/O owner off the main event loop.

Loading a Node-API bridge into Electron main is enough to prove the mechanism, but native crashes
would terminate the app. A dedicated native host improves crash containment at the cost of
actual platform-handle transfer and more lifecycle work. Electron's `ioSurface` buffer contains
a process-local IOSurfaceRef, not a serializable global handle; moving this design to another
process needs a Mach-port transfer/lookup bridge. Linux file descriptors likewise require FD
transfer, not JSON integers. This study does not select either production process model.

## Patch inventory and Linux risk

The retained Ghostty patch changes seven upstream files. This is an exact description of the
experiment, not an estimate of the final migration patch set:

| Actual upstream change | Purpose / likely disposition |
| --- | --- |
| `build.zig`, `src/build/GhosttyLib.zig` | Install the Darwin shared-library artifact and link Metal explicitly. The first native link failed on six unresolved Metal symbols before that link was added. A private native target needs a maintained build path. |
| `src/build/SharedDeps.zig`, `src/renderer/metal/shaders.zig` | Compile unchanged upstream MSL at runtime because this machine has no `xcrun metal`. Experimental toolchain accommodation; production may keep upstream offline compilation instead. |
| `src/renderer/Metal.zig` | Replace layer presentation with a completed-surface callback. Reuse the upstream renderer, shaders, font path, and texture allocation. A production API would be per instance and include explicit lifetime/generation handling. |
| `src/apprt/embedded.zig` | Expose the existing manual output API. Production needs a selected external transport seam, not this global experimental facade. |
| `src/termio/backend.zig` | Intercept writes for the transport probe. Replace with a real external backend if that ownership model is chosen. |

The small standalone C bridge is ordinary maintained source under
the existing source budget. It is a disposable test adapter, not an application plugin or a
proposed public API. The installed experimental dylib was approximately 18 MiB on this target;
that is not a release payload-size or dependency-closure promise.

Additional production work is **inferred**, not demonstrated: remove the dummy NSView dependence
with explicit size/scale/runtime options; provide a per-session presentation and event facade;
design consumer leases or fences through resize and renderer loss; replace idle exec ownership;
bound stream/mailbox work; integrate actual keyboard/IME and hvir events; and package supported
targets. Render-target retention alone is insufficient: upstream's three-frame swap chain releases
a frame after Ghostty GPU completion, before Chromium is necessarily finished reading it.
The experiment's extra GPU export pool is one demonstrated solution, with measured local cost.

Linux remains the largest unqualified platform risk. Source-backed improvements in 1.4 include
the renderer-owned EGL context, offscreen targets, DMA-BUF export, and a completed-frame queue.
`opengl/Device.zig` can use an external display or the surfaceless Mesa default.
`opengl/Frame.zig` calls `gl.finish()` before publishing an exported frame: do not assume an
asynchronous zero-stall path. `OpenGL.zig` also has a CPU pixel fallback when DMA-BUF export fails;
that fallback does not qualify the intended GPU path. The embedded platform API is still macOS/iOS,
so Linux needs runtime/presentation/build integration beyond this macOS callback patch.

No Linux build or DMA-BUF import was run. EGL/display selection, export modifiers and formats,
FD lifetimes, browser import compatibility, NVIDIA/Mesa, Wayland/X11, and multi-GPU behavior remain
open. GTK-free distribution is not established. The smaller renderer/runtime coupling is useful
evidence, not a promise that all drivers or headless library builds now work.

## Preserving the hvir experience

Current owners are starting points: `TerminalPane`/Ghostty adapter; terminal runtime and
presentation registry; PTY supervisor and `ProjectHost`; harness providers; and main clipboard,
file/link, recovery, and renderer-authority owners. This experiment changes none of them.
It introduces no production dependency direction, budget exception, or permanent API.

| Behavior | Qualification / next integration obligation |
| --- | --- |
| Keyboard protocols, IME, mouse, selection, bracketed paste | Native mechanisms exist; only native text input was exercised. Browser/native event translation and composing text require targeted real interaction probes. Do not replace them with the experiment's simple key echo. |
| Scrollback/search, semantic navigation, exact copy | Internal redesign required around native state. Current hvir occurrence/provenance identity must fail closed on overwrite/reflow/eviction. Coordinate snapshots or atomic native query/extract operations must preserve exact text; public VT location anchors alone are insufficient. |
| Clipboard and image paste | Keep reads denied, bounded writes qualified by a current live authorized attachment, and replay inert. Native clipboard callbacks in this prototype always refuse/ignore; this is an unimplemented workflow, not a proposed user-visible removal. Retain explicit image-paste host targeting and cleanup. |
| Links | Native recognition/OSC8 must produce user-activated typed events with the correct host/session. Printing a link grants no read; link text is never executed. Existing outside-project viewing and loopback policies remain product outcomes. |
| Titles, attention, palette, semantic events | Native callbacks/internal handlers cover useful mechanisms, but hvir's raw event distinctions and authority need an explicit mapping. Do not blindly port every ghostty-web patch. |
| Settings, splits, focus, Workspace/Sessions | Keep hvir's existing controls and familiar behavior. Native terminal lifetime must outlive DOM presentation attachment; reparenting, hidden state, and close must remain distinct. Native app window/split/config actions must not create a parallel user workflow. |
| Launch/recovery and local/SSH | Preserve exact provider-owned recovery, host/session identity, and visible failure states. Input/paste/copy must target the intended current session. The local transport probe supports the approach, not full ProjectHost integration. SSH is untested here; coordinate with #1080/#1086 without implementing that feature. |

No user-visible difference is proposed for adoption by this report. All missing prototype
features remain required behavior or subjects for an explicit later decision. ADR-003's stable
Linux API prerequisite and current interface/process/PTY assumptions are candidates for deliberate
replacement, as the maintainer authorized. ADR-001/010/014/024/035/040 describe current constraints
to account for; they do not forbid exploring a better internal design. Record durable changes
when the production design is selected, not as experimental results in ADRs.

## Proposed next work and acceptance method

The next smallest useful boundaries are (1) real Linux GPU import plus a matched responsiveness
comparison; (2) selected process/transport/presentation ownership and a pinned private embedding
facade; then (3) focused behavior integration and distribution. These are recommendations only;
no further issues were created. Retain the demonstrated upstream mechanism and risk evidence.
Discard or rewrite this bridge, global callbacks, idle exec, fixed scale, and synthetic key handling.

Before production adoption, agree a repeatable comparison against current hvir and native Ghostty
on the same machine, display, fonts/grid, workload, and power settings. Include 60 Hz and available
120/144 Hz displays, multiple visible terminals, inactive live sessions, and workbench navigation.
Run warmed repeated samples for inertial scrolling, sustained output, input echo, and resize;
separate normal runs from delayed consumer, hide/show, renderer-loss, and GPU-failure probes.
Reuse hvir's capacity/presentation fixtures where useful rather than add a permanent benchmark
framework to this study.

Suggested adoption bar for maintainer agreement: a perceptible improvement supported by lower
missed presentation deadlines or input-to-present latency in the currently problematic workloads,
without a material regression elsewhere; no ordinary workbench task above 50 ms caused by terminal
load; bounded memory/queues and successful resource release under stress; and no unaccepted
workflow/authority regressions. Collect presented-frame timing or a high-speed camera/trace
correlation for input-to-visible-pixel latency, p50/p95/p99 frame intervals, main/renderer long
tasks, CPU/GPU utilization, and memory. Define numerical regression tolerances on controlled
hardware before judging adoption. JS `requestAnimationFrame`, PTY echo, and this copy timer alone
cannot establish those results. Missing Linux/driver evidence prevents a dual-platform readiness claim.

## Reproduce and clean up

Prerequisites: Apple Silicon macOS with Metal, a Ghostty clone containing the exact tag commit,
Zig 0.17.0, clang/SDK, a directory containing Node's `node_api.h`, and `npm ci` in this hvir worktree.
Use absolute tool/header paths. The build downloads Ghostty's pinned dependencies as needed,
archives source into a fresh temporary directory, and never edits the supplied Ghostty clone.

```sh
bash scripts/native-ghostty-qualification/build.sh \
  /absolute/path/to/ghostty /absolute/path/to/zig-0.17.0/zig /absolute/path/to/node/headers

# Set this to the exact experiment directory printed by build.sh.
qualification_work=/absolute/path/printed/by/build
HVIR_QUALIFICATION_BRIDGE="$qualification_work/bridge.node" \
HVIR_QUALIFICATION_LOG="$qualification_work/native.json" \
HVIR_QUALIFICATION_SCREENSHOT="$qualification_work/native.png" \
node scripts/smoke-run-lock.mts \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/native-ghostty-qualification/main.cjs

HVIR_QUALIFICATION_LOG="$qualification_work/web.json" \
node scripts/smoke-run-lock.mts \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/native-ghostty-qualification/web-main.cjs
```

The shared contributor smoke lock serializes desktop use. The native run ends after about
13 seconds, or window close/SIGINT/SIGTERM: stop timers, terminate an outstanding disposable PTY,
destroy the receiver, wait up to five seconds for all texture references, free Ghostty and native
resources, write observations, then quit. A timeout/cleanup error is a failed run, not a pass.
The browser run disposes its terminal after ten seconds; its watchdog fails after 25 seconds.
Unexpected native process death still relies on OS resource cleanup; crash isolation is future work.
Keep the printed temporary directory while inspecting artifacts, then remove only that scratch
directory through normal local cleanup. No worktree, installation, or personal terminal data is modified.

Verification of the retained upstream patch applied it to a fresh archive and compared all seven
resulting files byte-for-byte with the successfully built source. C compilation used `-Wall -Wextra`.
Normal app startup, installation, packaging, and production source do not import these scripts.
The experiment is invoked only through the commands above.

## Primary implementation references

- [Ghostty v1.4.0 source](https://github.com/ghostty-org/ghostty/tree/83fb95624b0439ee660c2679b43b38c8b63769cd): `include/ghostty.h`, `src/apprt/embedded.zig`, `src/Surface.zig`, `src/termio/Termio.zig`, `src/termio/backend.zig`, `src/renderer/generic.zig`, and Metal/OpenGL device/target/frame implementations. Public `libghostty-vt` alone does not provide this native renderer.
- [Linux EGL/DMA-BUF renderer separation](https://github.com/ghostty-org/ghostty/commit/2f0b65346918047518e7b32f9bbfa1240c15b62e).
- [Electron sharedTexture](https://www.electronjs.org/docs/latest/api/shared-texture), [handle semantics](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle), and [native design](https://github.com/electron/electron/blob/main/shell/common/api/shared_texture/README.md). These remain experimental APIs; this report binds its measured claims to Electron 43.8.1.
