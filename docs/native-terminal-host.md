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
A measured main import is one observation, not the performance gauntlet.

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
