# Native terminal state and presentation

The native host and macOS presentation adapters implement the state, resource,
and presentation boundaries for epic #1090. Normal sessions continue using the
existing terminal runtime until M7 wires these adapters to the PTY supervisor.
The production preload owns a sandboxed GPU canvas receiver; native presentation
requests require an already authorized prepared state and a current main-issued
view grant.

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
one VideoFrame is insufficient. Indeterminate import or send failures retain the immutable source, received OS
reference, main import (if one was returned), and one of the three import credits
for the application lifetime. Presentation becomes unavailable and its grant is
revoked. The same parser continues accepting authoritative output, readback, and
acknowledged geometry; presentation failure does not destroy the terminal state.
A destroyed receiver or the old high-level callback is insufficient to reclaim
these resources: Electron 43.8.1 can create a late consumer after its send timeout
without the missing creation sync token reaching that callback. Explicit terminal
close may destroy its parser, while uncertain physical resources remain held until
application shutdown. This is a bounded unavailable outcome, not transparent
recovery or successful resource reclamation. M15/M16 must explicitly retain or
accept this limitation before cutover.

The one recoverable import failure is the pinned Electron rejection
`Failed to import shared texture: GPU is not available`, which occurs before
`CreateSharedImage`. After releasing that unsent receive reference, the presenter
can select native pixels on the same parser and PTY. Other thrown imports are not
assumed safe. No usable native renderer still requires the retained legacy path
or an explicitly accepted support decision.

## Production presentation owners

`NativeTerminalPresenter` shares the existing Host and FrameImports owners. It
creates an opaque view ID, qualifies the actual receiver, coalesces geometry,
and permits one in-flight demand per view. One immutable source lease is valid;
three is the import cap, not a required copy pool. A slow former consumer retains
its source lease while a new attachment acquires authority. Demand then reports
backpressure until that source physically releases. Detach revokes locally,
occludes the old attachment, and never waits for an old consumer to authorize
its replacement.

Source release uses the existing native draw-only notification. It does not wake
the full update path merely to rebuild unchanged cells and export another frame.
Native cursor timers may still produce bounded redraws; idle acceptance counts
completed leases over a fixed window with enough polling opportunities, separately
from visible cursor-blink pixel checks. Unavailable/quarantined views stay natively
occluded even when a blocked handle is attached again.

Applied geometry includes backing scale (finite 1 through 4), physical extent,
and the actual native cell grid. Equal dimensions still advance the serial.
The same upstream Surface performs font/DPI changes, and the IO acknowledgement
reports actual applied scale. Failed font-grid allocation leaves the prior font
size intact; a failed/pending serial cannot label a new acquired frame. Hidden
states keep parsing and use upstream occlusion to stop drawing. Zero-sized DOM
measurements do not replace the last usable geometry.

The inward `NativeTerminalViewGrant` and presented-frame DTO contain the main
view ID, native epoch, attachment, and exact acknowledged geometry. One isolated
preload receiver multiplexes grants. It closes stale frames and wrappers. A
retained `NativeTerminalSurface` implements the small DOM/presentation port used
by the existing Workspace/Sessions attachment owner; it drives coalesced visible
frame demand and watches CSS extent/backing scale without owning a parser.

`NativeTerminalPresentationTargets` owns pending pixel tickets and exact-frame
acknowledgements. Its feature registrar uses the existing IPC authority router,
owner policy, and typed terminal contract. Main-frame and current-owner checks
precede the domain's exact target/grant checks. The normal registrar ignores
acknowledgements when M7 has not supplied an authorized presentation owner.

The GPU canvas uses WebGL VideoFrame upload and performs no routine readback.
The native Metal target contains Display-P3 pixels. The adapter preserves numeric
values using `UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE`, requests premultiplied
VideoFrame upload, and sets the drawing buffer to the actual source color space.
It intentionally retains the sRGB unpack selector for the pinned Chromium GPU
copy path; forcing that selector to P3 disables the fast-path eligibility.
Compatibility RGBA uploads use straight alpha and multiply once in the shader.
The currently exposed native configuration is opaque; translucent native settings
remain unqualified rather than being inferred from opaque color tests.

Native pixel compatibility explicitly copies a completed held IOSurface on the
designated engine worker. The copy is bounded to 16 MiB (2048×2048 packed RGBA),
one request per view and three outstanding uploads application-wide, paced to at
most one accepted upload per 67 ms. Worker normalization converts BGRA premultiplied
pixels to straight RGBA/top-left without changing their color-space interpretation.
The receiver uploads to WebGL, or to an sRGB 2D canvas when browser GPU use is
unavailable. The ImageData retains the actual source P3 tag, so Canvas2D performs
the conversion rather than interpreting P3 numbers as sRGB. It displays “Compatibility rendering”; bound or context failures
display “Terminal unavailable”. Context loss is latched locally and qualified
back to main, so later GPU status cannot mask it. This path does not qualify as
native GPU presentation.

The 16 MiB compatibility limit does not cover every historically supported large
viewport. Initial engine selection must retain the necessary legacy path when
native presentation cannot support the requested configuration; a live bound
failure reports unavailable rather than switching engines from partial replay.
M15/M16 must cover or explicitly accept this limit before removing that legacy path.

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
Every gap must be **at most 500 ms**, reusing the existing absolute responsiveness
maximum. Nearest-rank p99 and sample counts remain reported. The controlled
full-workbench capacity gate retains its **p99 less than 100 ms** requirement in
M15; this standalone hosted M4 probe does not qualify that controlled performance
budget and reports `controlledCapacityQualified: false`.
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


## macOS presenter acceptance

After the native/binding build above, run both production receiver paths:

```bash
npm run native:presenter-probe -- --library=/absolute/trusted/artifact/libghostty.dylib
npm run native:presenter-probe -- --compatibility --library=/absolute/trusted/artifact/libghostty.dylib
```

The compatibility command disables Electron hardware acceleration before startup;
Ghostty still renders with Metal in its utility. The proof uses the production
presenter, IPC registrar, sandboxed preload, and canvas. It checks independent
view grants, 1→2→1 scale changes, equal-size serials, hidden parsing and retained
DOM reparenting. Controlled truecolor blocks prove orientation. Opaque midtones
are compared with independent CSS sRGB reference blocks in the same capture, so
both GPU and pixel paths must honor the actual P3 source interpretation. Capture
is an observer-only readback. The GPU receipt requires zero native copy requests;
compatibility requires actual copies and exercises its maximum upload and refusal
above that bound. Each run requires final native utility exit and an actual
successful Electron process exit. Main and renderer heartbeats include first shader/upload, scale changes,
hide/reveal and the maximum compatibility upload. Each records its final partial
interval, sample count, nearest-rank p99 and maximum; both enforce a 500 ms
absolute maximum, with no claim of the controlled M15 performance gate.

Physical movement between Retina/non-Retina displays, physical latency, translucent
settings, installed/signed packages, and whole-workbench terminal interaction are
separate acceptance evidence. Forced scale transitions do not claim an untested
external display. M6 consumes the shared grants, acknowledged geometry, visibility,
and physical lease owner while supplying Linux presentation/driver evidence;
M7 owns live PTY runtime composition, M8 input, M12 settings, and M14 packaging.
