# Native terminal process and resource qualification

The native host is a qualification seam for the migration in epic #1090. Normal
sessions still use their existing terminal engine. This work does not enable a new
production pane or change PTY spawning, harness policy, or recovery.

`NativeTerminalHost` authorizes immutable PTY instances against a main-owned
session resolver. Renderer generations and attachment serials authorize current
presentation operations; they do not own parser lifetime. Trusted PTY output can
continue while a renderer is absent. Reattachment renews presentation authority
without creating another parser. A native host failure makes its existing states
unavailable; it never relaunches a harness or reconstructs terminal state.

One lazy Electron utility process shares multiple native states. Its JavaScript
scheduler admits at most 64 commands / 1 MiB, including physically active jobs,
with per-state limits of eight commands / 128 KiB. One dedicated Node worker
thread owns every synchronous engine call, including initialization and cleanup.
Controls have a bounded burst of four before pending feed work; states rotate
within each priority. Creation begins without waiting synchronously for native
geometry; short inspections yield between polls. Accepted producer deliveries
are copied and split into ordered 16 KiB chunks. A concurrent delivery to the
same state is explicitly rejected and retires that state; callers must await the
previous delivery rather than drop or interleave producer bytes.

Main ordinary control admission is capped at 31 global commands and six per state,
leaving producer credit for one chunk per bound state. A proven-unsent refusal of
the first feed chunk preserves the parser and stream sequence for explicit retry
or backpressure. A bound/failure after accepted partial delivery, or an
indeterminate submitted operation, retires that state; no partial delivery is
silently replayed.

Logical cancellation retains physical command credit until completion. A late
successful creation is destroyed; a late acquired frame is released against its
original state. Invalid or unprovable cleanup retires the host. Releasing a lease
with `HVIR_PRESENTATION` still releases its ownership; that state's presentation
failure does not invalidate unrelated parsers. After the last state, preparation,
and outstanding lease settles, the dedicated caller closes the engine and the
utility exits. A new ordinary session starts a fresh native generation.

The resource-only main addon never links Ghostty. macOS uses public bootstrap
check-in/lookup with a unique endpoint, authenticated Mach HELLO/ACK and an actual
IOSurface Mach send right. Linux uses a private-mode Unix sequence-packet socket,
kernel peer credentials and SCM_RIGHTS. Tickets, expected PIDs, metadata and
ancillary counts are validated; resource acquisition/release uses owned native
records rather than mutable JavaScript fields. Source references are retained or
duplicated before asynchronous work. Endpoint handshakes serialize; the addon
bounds eight asynchronous jobs and sixteen endpoints.

Electron imports only main-local resources. The main importer bounds three
pending/held imports and checks current attachment, geometry, color space,
premultiplication and format. A completed producer lease remains immutable until
Electron's `allReferencesReleased` callback. A renderer acknowledgement or closing
one VideoFrame is insufficient. If `sendSharedTexture` times out, the source is
retired immediately and the main reference is quarantined until retirement and
target-frame destruction. Electron 43.8.1 can deliver a consumer after its one
second timeout; its late wrapper release can log an upstream missing-reference
error. The qualification exercises this condition without releasing the source
early.

## Reproducing the boundary proofs

Start with a trusted local build or an artifact from the exact native CI producer.
Matching a manifest's own hashes checks consistency, not authorship. See
[native build inputs](native-terminal-build.md) for source and toolchain identities.
The upstream application's version, libghostty-vt version, private ABI, Electron
header version, producer revision and consuming binding revision remain distinct
in `bindings.json`.

```bash
npm ci
npm run native:bindings -- macos-arm64 /absolute/trusted/artifact /tmp/new-binding-build
npm run native:resource-probe -- packages/native-terminal/build/Release/resource-probe
npx electron-vite build --mode native-terminal-probe
npm run native:host-probe -- --library=/absolute/trusted/artifact/libghostty.dylib
```

For an uncommitted development checkout, add `--development` to `native:bindings`;
its receipt remains explicitly developmental. The build work directory must be
new. Addons use pinned authenticated Electron headers / Node-API 8, and macOS
bundles explicitly retain the macOS 13 deployment floor. Binding inputs are copied
to owned staging before compilation and their actual hashes/arguments/dependencies
are recorded. The producer artifact is not modified.

On matching native Linux x64 or arm64, select `linux-x64` or `linux-arm64`, use
`ghostty-internal.so`, and run the Electron command under `xvfb-run -a` when no
display is available. The native workflow runs both platforms and macOS arm64,
preserves executable modes in archives, and retains proof/provenance receipts.
The standalone fault-probe main/preload entries exist only in the
`native-terminal-probe` build mode; production builds omit them.

The resource probe intentionally uses synthetic IOSurfaces or memfd descriptors.
It proves rights/FD transfer, credential/ticket rejection, cancellation, bounded
admission, mutation-safe release, malformed Linux ancillary cleanup and warmed
resource counts. It does not prove GPU backing.

The Electron probe uses actual Ghostty completed frames and checks native marker
readback, stream sequence and renderer pixels. It also checks independent states,
main/renderer progress, idle restart, native host loss, initialization failure,
pre-initialization shutdown, producer death while a renderer holds a frame,
renderer-process death with a held lease, and the real Electron transfer timeout.
It measures main heartbeat gaps at a nominal 5 ms and renderer gaps at 10 ms,
using each loop's own monotonic clock. Acknowledged `native` and `transfer` phases
cover initialization, concurrent parser/render work, resource transfer and the
first real import/readback. Each phase requires at least two gaps from each loop.
Nearest-rank p99 must be **less than 100 ms**, and every gap must be **at most
500 ms**, reusing `CAPACITY_PERFORMANCE_BUDGETS` from the existing capacity owner.
Phase termination also records the final partial interval so a stall at the end
cannot disappear from the evidence. Deliberate producer/renderer crash, reload,
and the injected renderer stall are outside these measurement phases.

Every synchronous `importSharedTexture` call is separately timed on main and
must complete within that same **500 ms absolute maximum**. A GPU-import receipt
requires at least one measured import; owned-pixel Linux fallback reports no
import samples instead of a successful import claim. The JSON receipt records
phase sample counts, p99 and maximum gaps, all import durations and their maximum,
plus the exact policy bounds. Native CI reasserts the receipt's policy and measured
values. The consuming run supplies actual observed durations; these enforced
limits do not claim a measured value for an unrun platform, full-app latency, or
performance-gauntlet qualification.

Completed-frame fixture waits release legitimate older initial frames (including
stream zero) and wait within a fixed deadline for the fixture's expected stream
and acknowledged geometry. That is qualification-fixture correlation, not a
production requirement to import only the latest parser stream.

Linux software CI may return owned pixels rather than a DMA-BUF. Its receipt
reports `unavailable-owned-pixels`; synthetic SCM_RIGHTS success does not qualify
Ghostty GPU import. Even an actual DMA-BUF import is distinct from driver/device
and manual hardware qualification. The raw import probe preserves the actual origin metadata; it does not qualify
orientation. Linux exports currently use bottom-left origin while Electron imports
assume top-left. M5/M6 must normalize consumer orientation and prove scaling/color
interpretation before production presentation.

Linux native GPU presentation remains blocked
on that hardware evidence in #1113. No software-only result authorizes production
GPU presentation.

The disposable Electron qualification is externally bounded to 75 seconds by its
Node launcher. It captures both output streams and content-free phase markers,
requires actual exit zero plus one completed receipt, and cleans only its own
detached process group. A receipt followed by a stuck process or inherited pipe
is a failure; a timeout never becomes acceptance.

Release and destroy use reserved cleanup admission inside the same 64/8 command
bounds. Contending cleanup intents coalesce per state or lease and yield before
retrying proven-unsent admission pressure, with a 15-second admission deadline. After an unprovable operation, the failed
producer has a separate bounded 15-second termination-confirmation interval.
Lease/state ownership stays recorded until the native acknowledgement; destroy
BUSY retains the C record until a later release and final destroy. Unconfirmed
cleanup fails the native host and quarantines import credit rather than reporting
physical release. Renderer revocation does not revoke this cleanup authority.

In the producer-death fault, a retained receiver frame remains readable and the
main OS receipt is released. The dead producer cannot acknowledge its C lease
release. An observed exit of the owned utility for that exact native epoch is
separate physical evidence: after Electron's final consumer release, references
and import credit settle using that exit fact. Merely unavailable transport is
insufficient; unknown cleanup waits for confirmed termination within its bound
or remains quarantined. The lost generation never supplies another parser or frame.

The qualification observer transfers a clone of each fixture VideoFrame to a
dedicated Web Worker for GPU-to-CPU copying and pixel hashing. It admits one
observation at a time, bounds its completion, and closes the worker-owned clone
before replying. The original frame stays with the preload for held-consumer
proofs. Only the disposable probe allows Blob workers; normal preload and
production presentation are unaffected. Main and renderer heartbeat measurements
include the first readback end to end. Bounded phase statistics and readback/scan
timing are printed before the unchanged responsiveness assertions, including on
failure. These diagnostics distinguish observer cost from the native transfer path.

If a Linux CI probe's owned main process is still alive after 65 seconds, the
external launcher requests a bounded function-only native stack before its
independent 75-second rejection and process-group cleanup. A denied unprivileged
attach is recorded; CI may attempt the same fixed diagnostic through noninteractive
sudo without changing ptrace policy. Diagnostic output, subprocess lifetime and
fallback are bounded, and no diagnostic result can turn a timed-out probe into a
pass. Utility spawn/exit markers retain the captured native epoch and PID,
including initialization failures; public app quit and return markers locate the
shutdown stage without claiming a cause from an alive-process snapshot alone.
