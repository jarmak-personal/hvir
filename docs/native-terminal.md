# Native terminal contract

[ADR-086](adr/ADR-086-native-terminal-state-and-presentation.md) selects the architecture.
This document specifies its ports and proof obligations for [epic #1090](https://github.com/jarmak-personal/hvir/issues/1090).
The [compatibility inventory](native-terminal-compatibility.md) binds existing behavior and
fixed measurement rules to the migration. Implementation and acceptance state belongs in
issues and PRs; this document does not claim that a specified capability is implemented.

## Ownership and dependency direction

| Owner | Owns | Public boundary and permitted dependencies |
| --- | --- | --- |
| Main session coordinator | Admission, immutable live PTY binding, native-state identity, host lifetime, engine choice, current presentation grant | Uses provider/supervisor/ProjectHost and terminal-host ports; no Ghostty linkage or parser policy |
| Native terminal host | One parser/grid and render state per terminal, native IO/render threads, state operations and query lifetimes | Implements engine-neutral terminal operations; a private facade uses exactly one pinned Ghostty core |
| Main resource adapter | Receiving OS rights, local import references, Electron shared-texture import and consumer completion | Depends on resource metadata and a narrow C bridge; no provider, project, terminal parsing, or layout policy |
| Renderer terminal controller | DOM input/composition, interaction state and current presentation attachment | Depends on terminal-state and presentation ports; receives asynchronous results; no Ghostty/platform handles |
| Platform presenters | Producer resources, completion, lease pool, compatibility pixels and capability detection | Implement macOS Metal/IOSurface and Linux EGL/DMA-BUF resource edges; no PTY or user clipboard authority |
| Existing feature owners | Provider launch/recovery/composer behavior, clipboard/link/navigation/attention/settings policy | Consume copied terminal events or terminal ports; never concrete native state |
| Build/package owners | Full-source and toolchain pins, patches, binaries, licenses, loading and distribution | Produce immutable versioned artifacts; no session lifecycle or download at end-user startup |

Use one lazily started utility process shared by native terminals. It loads the Node-API C
edge and Ghostty; main loads only the C resource edge. Shared terminal contracts import
neither process implementation, Electron, Ghostty, nor resource adapter. Renderer consumers
cannot import main/native implementation, including erased type imports. IPC registrars and
entry points validate/translate/wire; they do not become terminal coordinators.

The selected source ownership is concrete:

| Maintained source / artifact location | Responsibility and language |
| --- | --- |
| `packages/native-terminal/` | Independently hvir-owned private facade, Node-API binding and OS-resource edge: `.c` / `.h`, package binding metadata and the small TS/JS loading edge. The facade calls minimal versioned Ghostty exports; it does not embed a standalone hvir Zig implementation. |
| `src/main/terminal/native/` | Main session/native-host coordination and Electron resource adapter, in TypeScript. Main's native resource binding does not load Ghostty. |
| `src/native-terminal-host/` | Utility entry and host adapter, in TypeScript; loads the maintained C facade and pinned Ghostty library. |
| `src/shared/terminal-engine/` | Domain-named engine-neutral ports/protocol contracts, in TypeScript, importing no concrete process/engine/resource edge. |
| `scripts/native-terminal/` | Build/provenance/upgrade tooling and manifest, in the existing TS/JS/shell languages and data formats. |
| `scripts/native-terminal/patches/*.patch.txt` | Genuine reproduced modifications to pinned Ghostty-owned embedding/backend/renderer/core exports, using the accepted external reproduction-patch text convention. Not a maintained hvir Zig host/facade/transport hidden as text. |
| `out/native-terminal/<target>/` | Disposable build products/manifests, never maintained implementation source. External source/dependency caches stay outside the maintained tree. |

Existing seam checks and runtime/type direction checks remain applicable. Each new native
output gets an exact build-artifact loading disposition with its C source, binding, export
header and generator inputs in the existing graph owner, as for the existing native packages.
This is not a generic `.node` exemption. Existing `packages`, `src` and `scripts` roots and
C/header/TS/JS budgets cover all independently owned source selected here. Native compilation,
link inputs, exported-symbol inspection and focused resource tests prove the boundary the
TypeScript graph cannot inspect. M2 must also prove actual shader toolchain/artifacts; the
prototype runtime MSL workaround is not production compiler or package evidence.

An upstream patch may expose external feed/reply/geometry/frame callbacks, adjust a generic
search option, or retain protocol provenance inside the core that already owns that operation.
M2 records its upstream-owned files, purpose, clean-source application and resulting digests.
New hvir application, process transport, resource protocol or facade implementation belongs
in the maintained C/TypeScript locations above, never a standalone Zig module serialized into
`.patch.txt`. No new language policy is required by this selected design. If implementation
actually requires independently maintained Zig, C++ or Objective-C, the consuming child names
that requirement as an unaccepted policy-only blocker before adding or consuming the source.
A focused separately accepted proposal is then required; the presence of a patch cannot waive it.

## Session-state port

This is the required semantic interface, not a new generic transport framework or a promise
to preserve existing synchronous `TerminalPane` methods. Concrete TypeScript/C names may
follow their owning modules. Keep the operation set small:

| Operation | Required semantics |
| --- | --- |
| Prepare/create | Verify build/facade compatibility and native capabilities before PTY spawn. Create one state and apply initial settings and geometry; return opaque state identity and applied geometry. Partial failure releases all acquired resources. |
| Feed | Accept ordered output with monotonically increasing stream sequence; acknowledge applied sequence/credit. Reject old, duplicate, out-of-order or foreign work explicitly. Accepted data is neither truncated nor replayed twice. |
| Input/paste/focus/pointer/scroll | Encode against current native modes after validating the current input attachment; return user bytes separately from terminal replies. Preserve provider-owned overrides and exact fallback bytes. |
| Resize/configure | Serialize against native state. Return the exact applied serial and actual cell/pixel metrics; PTY notification follows that acknowledgement. A cancelled/superseded serial cannot notify later. |
| Search/select/resolve/extract | Asynchronous bounded state queries with cancellation, query identity and opaque authenticated ranges. Return unavailable/stale/cancelled explicitly; no borrowed pointers cross mutation boundaries. |
| Attach/detach | Grant/revoke presentation and input without recreating the parser or PTY. A fresh attachment gets a new serial even if geometry is unchanged. |
| Destroy | Revoke admission first, cancel queries, settle jobs and consumer leases, destroy state; repeated close has no additional effect. |

Main resolves an opaque authorized session handle to immutable PTY instance, host-qualified
workspace, renderer owner/generation, and native generation. Do not repeat that entire
authority object in every message or trust caller-supplied copies. Validate the handle at
the process boundary and revalidate before effects. Attachment serial and request/stream
serial qualify operations where applicable. Reused terminal labels or IDs confer no authority.
The utility connection has one main-owned app/host epoch; a new host never accepts the old
epoch's state handles. No native handle, stream command, or OS transfer is exposed to guests.

The supervisor reserves its immutable instance identity within start admission before native
preparation. Preparation is bound to that reservation and cancellation lifetime; only its
successful physical spawn activates PTY input/effects and commits the live binding. Creation
with applied geometry is not itself liveness. Cancelled/failed preparation frees native state
and cannot spawn later; a late spawned process is settled by the supervisor's existing
cancellation fence. M7 may revise the supervisor's internal preparation port to carry this
reservation rather than inventing a second PTY identity or trusting a renderer-provided one.

Ordinary PTY output currently arrives as decoded JavaScript strings through `PtyProcess`.
Preserve that contract initially: encode its Unicode text to UTF-8 once at the native edge,
test split source sequences at the actual adapters, and do not claim arbitrary binary fidelity.
The native facade itself accepts byte chunks and retains incomplete UTF-8/control sequences.
Before its first external feed, disable file/shared-memory image media and ambient input-file,
open/config/window/split actions on the actual full Termio/Surface configuration. Do not
assume the public VT constructor's safe media defaults govern private full-engine creation;
M3 proves this pre-feed fence, while M11 later proves routed effects and protocol behavior.
Future byte-transport changes require their own exact local/SSH evidence.

Maintain one ordered PTY write owner. User bytes, provider-framed paste, and native replies
must not interleave within an already accepted atomic provider write. Record applied input
and reply sequences separately so response bytes cannot arm submission/attention heuristics.
Parser callbacks enqueue copied reply/effect data and return; they never call back into the
parser or perform Electron, SSH, file, clipboard, or provider work.

The public `ghostty_terminal_t` wraps owned state, a stream, effects, searches, and tracked
references. It is not an ABI view of an internal `Terminal`. Reuse standalone public encoders
with authoritative mode values where possible. For stateful operations, reuse upstream
algorithms on the existing state or introduce a narrowly owned minimal borrowed-state export hook with explicit close semantics, called by the maintained
C facade. Never independently parse the same stream twice or cast the
Surface terminal to the public wrapper. M3 (#1110) proves this; M10 (#1118) extends the same owner.

## Scheduling, bounds and geometry

Native initialization, parsing, reflow, search, shaping, rendering, producer synchronization,
and blocking handle waits execute in the utility host/native threads or resource-edge worker,
not either UI event loop. Multiple sessions must make progress under sustained output. Queries
yield or cancel between bounded native slices; use existing native locking rather than adding
an independently mutable shadow state. Main's import/dispatch path performs only bounded work
whose cost is measured by M4 (#1111); calling a synchronous API does not prove its cost is small.

The current capacity fixture observes a 64 KiB per-session delivery buffer; the initial
attachment replay is a separate 256 KiB history and is never restoration proof. Preserve
that delivery owner's measured contract while introducing the native transport. Do not
force a new native queue to use an old size solely for compatibility: M3/M4 must select and
test explicit stream credit, chunk and total queue bounds before enabling their path, including
multiple-session throughput. Preserve the 10,000,000-byte scrollback setting.

Add credit or pause/resume at the real producer seam where needed; current `PtyProcess`
has no flow-control operation, so merely limiting a downstream array is insufficient.
M3/M4/M7 implement and test the selected local/SSH backpressure together. A refused chunk
is an explicit stream failure with revoked interaction, never a successful feed with missing
bytes. Do not grow an unbounded secondary queue or silently keep a live native display after loss.

Use a maximum of three outstanding export leases per presented terminal. Replace only frames
that have not been handed to a consumer; do not reclaim a lease until producer and consumer
lifetimes permit it. Hidden terminals continue state processing with zero routine presentation
frames. Retain at most one live search and one extraction job per terminal; changing the query
cancels its predecessor. Preserve the existing 256 semantic-region bound. M3/M4/M10 specify
finite reply/event/query payload and scheduling bounds in their focused contracts and test
overflow/slow-consumer outcomes before those APIs are enabled. No stage may defer establishing
a bound until after it has begun accepting unbounded work.

Geometry requests carry a new serial for every accepted transition, including equal dimensions.
Their state includes actual columns/rows, pixel extent and scale, and settings generation.
Initial applied geometry precedes spawn. For later changes, apply the matching native parser
geometry before the supervisor notifies the PTY; only the newest admitted noncancelled request
may notify. Do not use the old 75 ms renderer debounce or a sleep as the correctness fence.
Keep zero/hidden DOM measurements from replacing the last usable grid. Fonts and display scale
change real native metrics and participate in the same sequence. Input mapping and imported
frames use the acknowledged geometry, not speculative DOM dimensions.

## Frame and resource port

A frame contains state identity, attachment serial, frame serial, geometry serial, pixel
extent/scale/color interpretation, producer-completion status, and one opaque export lease.
It observes all state mutations through its recorded applied stream/input sequence. Carry
these observations for correlation; they do not make unrelated timestamps physical fences.
Platform-specific format, modifier, strides, offsets, planes, and local resources remain inside
the producer/transfer/import adapters and do not enter product consumers.

Linux transfers DMA-BUF descriptors with `sendmsg`/`recvmsg` and `SCM_RIGHTS` on an authenticated
app-owned endpoint. macOS transfers the right created by `IOSurfaceCreateMachPort` in an actual
Mach message and constructs a local reference with `IOSurfaceLookupFromMachPort`. M4 must prove
the endpoint/rendezvous, peer identity, cancellation, production sandbox behavior and cleanup;
the existence of those functions does not qualify a mechanism. Utility-process structured
messages transfer metadata/MessagePorts, not arbitrary FD or Mach rights. Never send an integer
or pointer Buffer and pretend its resource belongs to the receiving process.

The leading macOS rendezvous is private C `bootstrap_check_in` / `bootstrap_look_up` with
real Mach messages, bound to the expected utility PID/kernel audit identity and host
generation. M4 proves this inside the actual Electron utility lifecycle; M14 proves the
signed, relocated package. Use no deprecated bootstrap registration, Chromium private
symbols or unverified launch hook. Linux's private endpoint likewise admits only the
current app/host peer and closes unexpected/stale received descriptors.

The host's completed source may be copied by GPU blit into an independently leased immutable
export target. Producer completion precedes import. Main owns the received reference until
Electron's `allReferencesReleased` permits release; the send promise and rAF do not. The renderer
owns/ closes its received VideoFrame. Discard, failed import/send, timeout, detach, host loss and
renderer destruction release each reference exactly once without overwriting in-use pixels.
Retaining a descriptor keeps an allocation alive, not its content immutable. M4 proves actual
cross-process ownership and producer/consumer termination; M5/M6 prove full pane presentation.

Linux's internal exporter can silently choose `readPixelsAlloc` when DMA-BUF export fails.
Expose that mode and classify it as compatibility; do not record it as a native GPU pass.
Upstream `gl.finish` completion stays on the native render thread. Qualification must also
prove that swap-chain reuse cannot mutate frames Electron still holds.

## Compatibility and failure

M5 (#1112) owns macOS pixel-export compatibility; M6 (#1113) owns Linux pixel-export compatibility.
Use the same native state and bounded lease/presentation lifetime. Detect import failure before
spawn where possible; if it occurs later, revoke the old attachment and switch only its
presentation path while retaining the same state and PTY. Revalidate geometry and leases.
Bound dimensions, retained pixel buffers, copy scheduling and work; no routine readback is
allowed in qualified GPU mode. Test slow receivers, unavailable import, loss, teardown, and
their explicit responsiveness ceiling before M15 (#1122) recommends cutover.

Pixel compatibility still requires a usable native renderer. For a previously supported
configuration with neither usable native presentation path, select the retained web engine
before spawn. This is an explicit retirement blocker for M16 (#1123), not an implicit support
drop or permission to leave two engines running against one PTY. M15 cannot recommend complete
web removal until native coverage or a separately accepted support decision resolves it.

On host loss, main revokes all host-state handles and attachments, cancels queries, rejects
new native input/effects, and reports terminal unavailability. Existing PTYs remain owned by
the supervisor and are neither silently killed nor restarted. Stop consuming into a lost
parser and bound any retained transport work through its flow-control/failure contract.
The user may close, or explicitly restart/resume after the old instance is settled through
the normal provider/session owner. Explain loss of terminal state; do not imply process
continuity or automatically retype/replay output. The current bounded initial replay is not
a reconstruction mechanism. In-memory native state can survive a presentation replacement;
lost native state cannot. No snapshot archive or transparent reconstruction is selected.

Native clipboard normalization is not protocol authorization. Public callbacks can merge
OSC 52, iTerm2 Copy, and Kitty clipboard writes into one decoded request. Preserve original
protocol, selection and encoded-size information through a focused facade patch where needed;
M11 must enforce the existing OSC 52 allowlist and strict decode/UTF-8 bounds without silently
enabling another write protocol. All clipboard-read protocols remain disabled.

GPU-context loss with intact state revokes presentation and follows the selected presenter
failure/compatibility path. It must not create a new parser or shell. Session close revokes
input/effects first, settles PTY and native jobs, cancels queries, releases attachment/consumer
leases, then frees native state. A live lease may need to outlast its UI owner until physical
release; logical revocation never proves OS cleanup. App shutdown awaits bounded cleanup and
reports any failed stage without terminal contents, private paths, or credentials.
