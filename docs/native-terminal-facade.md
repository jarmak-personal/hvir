# Native terminal facade

`packages/native-terminal/terminal.h` is the maintained C boundary over the pinned
full Ghostty engine. It is an input to the native host, not an application renderer
API. Normal sessions do not select it until the integration and adoption children
complete. [ADR-086](adr/ADR-086-native-terminal-state-and-presentation.md) and the
[native contract](native-terminal.md) govern ownership.

## Caller and initialization

All operations on a host belong to its creating thread. This thread must be a native
worker, not Electron main or the workbench renderer. Wrong-thread calls fail before
reading or mutating terminal state. Ghostty retains its separate IO and render threads;
callbacks use a different queue lock and never invoke product work or reenter parsing.
The host integration owns job scheduling and cancellation outside this synchronous API.

Open checks the private hook ABI before initialization. The initialized library remains
mapped until process exit: the full API has no global shutdown operation. Closing a
host destroys its app and invalidates the caller's host pointer. The dependency's
info-only loader probe has not initialized Ghostty and may unload its library.

An optional process-local Linux EGL display is borrowed for the host lifetime. Supply
it before the app creates its first device. NULL uses upstream's surfaceless display;
changing a live device is rejected. Windowless macOS uses the existing Metal renderer
and an unattached native layer, without creating an NSView or window.

`hvir_terminal_open_linux` owns explicit render-node display selection and teardown;
its default path borrows upstream's selected display. Selection is immutable for the
host lifetime. Private ABI 5 configures initial auto/pixels mode and a CPU export limit
before renderer construction: zero disables external CPU export, while ordinary GTK
rendering retains its existing policy. The maintained constructor supplies 16 MiB.
The same-Surface mode command only enqueues presentation health; Linux compatibility
is applied only when a completed kind3 frame with current geometry arrives. Allocation
and GL readback failure report renderer-unhealthy without failing the parser; a later
successful completed frame restores health. Metal compatibility continues copying its
held kind1 IOSurface.

The optional renderer-info callback borrows bounded driver strings and the process-local
EGL display only while the render context is current. C immediately copies the strings
and queries measured device identity; Node receives no platform pointer. The snapshot
separates requested selection, actual native GL/EGL identity and frame/copy counters.
Missing facts, including Metal attribution, remain unknown.

External mode never constructs Exec, a shell, or a PTY. It does not load personal
configuration or configured initial-input files. File, temporary-file and shared-memory
image media and clipboard reads are unavailable; image storage starts disabled.
Unimplemented native application actions are metadata, never permission to execute them.

## State operations

Create fails with `HVIR_FAILED` if native engine/context setup cannot complete, or
`HVIR_TIMEOUT` if initial geometry does not complete within its bound. It does not
publish a state on these failures. A successful create returns an opaque monotonically allocated state identity only after initial
geometry serial 1 applies to the parser. Feed admits the next exact sequence and up to
65,536 bytes synchronously; it neither queues an unbounded backlog nor silently truncates
accepted output. Invalid sequences and over-limit calls fail explicitly. The host must
supply producer flow control or revoke a failed stream rather than treating an error as
successful delivery. Current ProjectHost output is decoded text; this native byte API
does not establish arbitrary binary fidelity through the application's existing adapters.

Input encoding reads the same parser's current modes. Encoded user bytes and native
replies remain byte spans. Do not round-trip them through UTF-8 strings: legacy mouse
and other protocol bytes need the main-owned PTY adapter's exact byte-write path.

The reply FIFO holds at most 65,536 bytes. Effects are copied synchronously from
borrowed native payloads, stamped with their causal feed sequence and native event serial,
and drained by the existing producer continuation. Three latest-value slots coalesce title,
raw working-directory URI and bell; at most 128 other records share a **total** 1 MiB owned
state-owned transport heap payload budget with those slots, including a pending replacement
allocation before its old slot is freed. Fixed record metadata is separately bounded by
128 FIFO records plus three latest-value records. The caller's return record separately has
fixed 128 KiB data/extra buffers; the copied batch is at most 1 MiB. NAPI/IPC/caller copies
are not a claim of a 1 MiB process or application allocation peak.
Each data/extra component is at most 65,536 bytes. Complete
supported OSC52 writes retain the existing 64 KiB encoded bound and full selection/protocol
metadata. Ordinary paste has no source ceiling.

Refused, malformed or saturated effects increment sticky out-of-band drop and semantic
generation counters; these remain readable with an empty/full FIFO or failed allocation.
They do not fail terminal parsing/input. A drain consumes at most 131 records, in surviving
native occurrence order. Semantic markers carry the actual post-mutation screen/cursor and
parser action/options; these coordinates are observations, not retained occurrence identity.
Screen reset/change is explicit. Native UTF8 validation refuses malformed text before the
text-only wire boundary; palette RGB metadata is explicitly binary.

Effect kinds are title (1), raw CWD URI (2), bell (3), notification (4; OSC9/OSC777 origin),
OSC52 write (5), semantic marker (6), palette operation (7), screen/reset (8), progress (10).
Internal malformed-text refusal (11) updates counters and never enters the event stream.
OSC9 remains quiet attention; OSC777/progress remain observational. Native application actions,
clipboard reads and other clipboard protocols remain disabled. Renderer health is independent
coalesced status (0 healthy, 1 unhealthy), never parser failure or frame proof.

Snapshot-qualified OSC8 readback uses viewport coordinates and exact stream, IO-applied input
mutation and geometry under the same native state lock. It copies URI bytes and never opens
anything. Stale snapshots return BUSY; malformed URI text returns no link. Product execution
checks, user intent and host-qualified navigation remain outside the native engine. Native
palette/theme query replies come from the same Terminal and existing reply FIFO; configured
native theme/settings changes belong to their settings owner. See
[ADR-089](adr/ADR-089-native-terminal-effect-authority.md) for authority and compatibility.

Readback formats the active retained screen as plain, soft-wrap-unwrapped text, with
upstream trailing-space/blank-row trimming. Its fixed caller buffer is at most 1 MiB;
insufficient capacity fails without claiming a successful partial result. This bounded
snapshot is not the authenticated range/search/extraction contract implemented later.

## Geometry and frames

Every resize carries a newer serial, including repeated dimensions. Its IO-thread
transition supersedes old coalesced work. Only the latest admitted serial updates the
C acknowledgement; initial and later PTY notifications must follow that acknowledgement.
Closing revokes pending acknowledgements. Geometry distinguishes the outer pixel extent,
content extent, actual cell metrics, padding, columns and rows; padding is not inferred
from a division of window size by the grid.

Private ABI 4 extends that acknowledgement with the actual backing scale.
`hvir_terminal_resize_scaled` accepts finite scale 1 through 4, reuses the same
Surface's font/DPI algorithms, and fences the resulting IO and renderer geometry.
The old resize wrapper selects scale 1. Font-grid allocation commits the requested
font size only after allocation succeeds, so a failed DPI request can be retried.
`geometry_failure_serial` identifies a failed native transition; it does not
advance applied geometry or fail the parser. Pending or failed geometry prevents
new frame acquisition. Existing immutable held frames remain releasable.

Visibility uses the same Surface's occlusion operation. Hidden state keeps parsing
while drawing is paused, and reveal rebuilds from that authoritative state.
`copyFrame` explicitly copies a completed held macOS IOSurface or owned Linux RGBA
frame on the designated caller, returning independently owned packed BGRA within a
16 MiB bound. It keeps
the original lease alive and increments `frame_copies` only on a successful copy.
The host worker owns compatibility-only RGBA normalization; ordinary GPU demand
does not call this operation. Presentation-unavailable result 9 differs from
temporarily absent/busy result 6, and neither authorizes parser destruction.

A completed frame carries the stream and geometry observations captured with the parser
snapshot and committed only after its image rebuild succeeds. Synchronized-output skips
cannot label an older image with a newer sequence. Its resource record is process-local: a retained IOSurface, duplicated DMA-BUF
planes, or owned compatibility pixels. Modifier is a full uint64; Linux plane allocation
sizes come from the descriptor's size query, not a tiled-layout guess. Color space,
orientation and premultiplication remain explicit. The receiving resource adapter must
validate/map these properties before using Electron's import API. DMA-BUF export requires
both per-display `EGL_MESA_image_dma_buf_export` advertisement and both loaded export
procedures: a resolved EGL entrypoint alone does not establish driver support. Missing
export capability reaches upstream's owned-pixel fallback; advertised, usable export
remains available for the hardware path.

One outstanding resource quiesces future drawing while parser and renderer control
mailboxes continue processing. Metal completion runs synchronously on the native render
thread; OpenGL publishes after its existing GPU completion. A normal release resumes
drawing. If rearm notification fails, the operation returns `HVIR_PRESENTATION` after
resource release, preserving parser state; duplicate release still succeeds. This result
is independent of GPU health and cannot be erased by an older frame completion. Failed
frame acquisition sets the separate `presentation_failure` status and leaves parsing
available. Taking a missing frame reports `HVIR_PRESENTATION` while that error remains;
a later valid acquired frame clears it. The
platform presenter children own the production three-copy export pool.

Take returns `HVIR_BUSY` while no completed resource is ready and `HVIR_PRESENTATION`
for an observed export/rearm error. There is no separate unsupported-capability result:
context setup failure is a create failure. Resource kind identifies the actual IOSurface,
DMA-BUF, or owned-pixel path; detailed platform selection belongs to the presenters.
Take rejects obsolete geometry. A lease remains immutable until explicit release;
a send timeout is not release. Duplicate valid release is harmless, while a foreign
lease cannot release another state. Never serialize pointer bytes or descriptor integers
as process transfer; the host/resource integration must transfer actual OS rights.

Destroy immediately revokes new work. With a held lease it stops and frees the engine,
retaining only the bounded C record and owned resource references, and returns BUSY.
Inspect, release and final destroy remain valid. Release after retirement never calls a
freed Surface. Closing the host is BUSY until all state/resource records are settled.

## Build and native proof

The [native build command](native-terminal-build.md) reproduces the ordered upstream
patches and compiles the maintained facade. Each matching-target build runs:

- The info-only loader identity/refusal checks.
- `facade-probe LIBRARY --frames`: a real pthread caller, independent states, ordered
  large ANSI/Unicode output, split sequences, raw replies/input, geometry and mailbox
  saturation, OS child/PTY checks, and resource release/reacquisition/retirement.
- `frame-metadata-probe`: immediate adapter validation and descriptor cleanup without
  initializing the engine. It can also be compiled with address/undefined sanitizers.

Closed JSON proof records are retained with the artifact. Native initialization, a
software Linux frame, or a passing facade probe does not qualify hardware GPU presentation,
Electron process transfer, package installation, or full-workbench compatibility/performance.
Those remain separate production acceptance gates.
