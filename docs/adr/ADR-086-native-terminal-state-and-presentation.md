# ADR-086: Native terminal state and independent presentation

> Lifecycle: Active
> Supersedes: [ADR-003](ADR-003-swappable-terminal-pane.md) | partial | ghostty-web and xterm.js engine selection, stable Linux embedding prerequisite, and the single TerminalPane interface as the required native boundary.
> Supersedes: [ADR-014](ADR-014-modular-monolith-ownership.md) | partial | TerminalPane facade stability and process placement for native terminal state and presentation.
> Supersedes: [ADR-024](ADR-024-demand-driven-terminal-workspace-lifecycle.md) | partial | Renderer-side ownership of materialized terminal runtime and presentation behind TerminalPane.
> Supersedes: [ADR-035](ADR-035-bounded-osc52-clipboard-write.md) | partial | Renderer-only OSC 52 parsing, decoding, and forwarding through TerminalRuntime.

## Context

Native Ghostty rendering materially improves the terminal interaction hvir is built around.
A synchronous, renderer-local terminal widget does not express native parser and renderer
threads, cross-process GPU resources, or state that outlives a DOM attachment. The stable
libghostty-vt C ABI covers terminal operations, not the renderer or private embedding API.

The migration reviews every terminal-related decision, including terminal rules in
cross-cutting ADRs. Existing names, interfaces, process placement, and implementation
mechanisms do not become requirements merely because an earlier ADR selected them.

## Decision

Use a pinned full Ghostty source build and a narrow, versioned private embedding facade
for native terminal state and rendering. Maintain focused upstream patches explicitly.
Reuse public input encoders and core algorithms where they operate on the same state.
There is one authoritative parser/grid per terminal instance. A public VT wrapper cannot
be fabricated by casting an internal terminal pointer, and a second parser cannot stand
in for access to the renderer's state.

Start one application-scoped Electron utility process lazily for native terminals.
It owns native state, parser work, render work, and bounded native jobs. Ghostty's IO and
render threads own their work; callback data is copied before borrowed storage expires.
Native creation, feed, queries, configuration, and destruction are serialized against
the state they access. Callbacks do not reenter the parser or run product side effects.
The process hosts multiple independently identified terminals and exits after its final
terminal and outstanding resources settle. Its loss invalidates all of its native states.

Main retains session authorization and the existing provider, PTY supervisor, and
host-qualified ProjectHost authorities. These are retained because they express exact
launch, transport, recovery, and project trust, not because their historical shape is
immutable. The native facade accepts external output and emits input and replies. It
spawns no shell, PTY, provider, project access, or ambient Ghostty application action.

Split the engine-neutral boundary into a terminal-state port and presentation attachments.
State belongs to one immutable live PTY instance and native generation. Attachment owns
one current surface, input/focus lease, geometry generation, and received frames. Recovery
records, PTYs, native state, visibility, focus, and DOM attachment have separate lifetimes.
Workspace/Sessions reparenting retains the state and grants at most one current input owner.
Asynchronous commands and queries have explicit cancellation and stale-result outcomes.
Consumers do not depend on Ghostty, platform resource types, or synchronous native access.

Main qualifies the terminal/PTY/native identity and attachment before importing or sending
a frame. A narrow C resource edge transfers actual OS rights: Mach rights for IOSurface,
and SCM_RIGHTS for DMA-BUF descriptors. A receiver constructs its own local reference;
serialized pointer bytes and descriptor integers are never a transfer mechanism. Only
the utility host loads Ghostty. Main's native edge owns resource transfer/import support,
not parser state. Blocking resource waits remain off both main and renderer event loops.

Metal/IOSurface and EGL/DMA-BUF are the normal presentation paths. A bounded export pool
keeps immutable frame content alive through producer completion and every consumer
reference's release. Retaining an allocation does not permit the producer to overwrite it.
Obsolete unconsumed frames may be replaced; accepted PTY output may never be discarded or
reordered. Hidden sessions keep parsing without rendering continuously.

Select the presentation path before starting a session. A bounded native pixel-export
path may cover failed shared-texture import while native rendering remains available.
It has explicit compatibility status and cannot qualify as the GPU path. Pixel export
does not cover the absence of a usable native renderer. Retain the necessary web path
until native compatibility covers previously supported configurations or an explicit
support decision replaces that requirement. Do not switch live engines from partial replay.

Applied geometry is an acknowledged parser-state transition. Initial geometry applies
before PTY launch; subsequent PTY resize notification follows the matching applied native
serial. Repeated dimensions, superseded requests, close, and recreated attachments do not
reuse an old acknowledgement. Frames carry their exact geometry serial.

Native effects report copied data and provenance to product owners. Main validates
current live authority again before side effects. Preserve bounded OSC 52 text writes and
refuse all terminal-initiated clipboard reads. Parsing and decoding may occur in the native
host; they do not confer clipboard authority. File/web activation remains explicit and
host-correct. Providers retain harness-specific input/composer behavior. The native engine
does not read arbitrary user Ghostty configuration or execute its application actions.

Host loss immediately revokes input, effects, queries, and presentation. It does not
silently terminate or relaunch an otherwise live PTY, reconstruct parser state from the
bounded initial replay, or reuse lost native identity. Preserve that PTY while presenting
its unavailable terminal state; explicit close terminates it. An explicit restart/resume
first settles the old instance, then follows existing provider-owned recovery or fresh-shell
behavior. A retained native state may accept a new attachment; a lost state may not.
No durable snapshot format or transparent crash reconstruction is selected.

Shared contracts point inward and import no process or engine implementation. Main and
renderer adapters depend on those contracts; composition roots only wire owners. The
existing source inventory and budgets cover C/header and TS/JS source. Native build output
requires an exact loading disposition and named maintained inputs; native compile/link,
dependency, and lifetime proofs supplement the TypeScript graph. New languages or relaxed
policy require separate prior acceptance. Pinned upstream patches are external source
changes with provenance, not a hiding place for hvir-owned native implementation.

## Consequences

DOM changes and UI rendering no longer own parser lifetime. Native work is isolated from
the UI event loops and failures are contained to an explicit shared host. A single host
minimizes process overhead, at the cost of multiple terminals losing native state together
if it fails. Native resources and async operations require explicit leases and revocation.

The private facade and renderer are pinned maintenance responsibilities. Stable VT ABI
claims do not extend to them. Real cross-process import, producer/consumer synchronization,
Linux GPU interaction, and package loading require platform proof before adoption. If a
selected transfer mechanism fails, revise this decision and its dependent contracts;
do not weaken isolation or substitute a different outcome silently.

Other terminal decisions are retained only for their independent user, trust, lifetime,
or responsiveness value after review. They remain open to further explicit revision
through ordinary decision records. Native adoption requires full-workbench compatibility
and performance evidence rather than preservation of historical implementation contracts.

## Rejected alternatives

- A VT-only replacement: it does not deliver native GPU rendering.
- Native parsing in main or the workbench renderer: it increases UI stalls and crash impact.
- One process per terminal: the expected isolation benefit does not justify its overhead.
- Two independently parsed copies for public queries and private rendering: state can diverge.
- Treating DOM detach as terminal destruction: it breaks retained Workspace/Sessions use.
- A generic RPC, terminal-engine plugin, or service-locator framework: the product needs one
  bounded engine integration, not a new extension platform.
- Restoring from bounded replay or unstable snapshots after host loss: neither proves exact
  live state, and invisible relaunch can duplicate or replace the user's harness.
