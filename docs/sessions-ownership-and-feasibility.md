# Sessions ownership and topology feasibility

This document is the ownership and feasibility gate for the global Sessions work. It
defines how later Sessions children compose existing facts without becoming a second
session authority, terminal runtime, provider observer, or activity classifier. It does
not implement projection, IPC, UI, usage sampling, terminal attachment, or topology.

The decisions below apply ADR-003, ADR-006, ADR-008 through ADR-010, ADR-012,
ADR-014, ADR-019, ADR-024, ADR-031, and ADR-034. They do not establish a new
project-wide rule, so this evaluation adds no ADR.

## Decision summary

`SessionsProjectionCoordinator` is the one named projection coordinator. It lives in
the existing Electron renderer process and is constructed by the Sessions feature, not
by `App` as a global state owner. The renderer is the only process that already owns the
current attention and terminal-presentation facts. Assembling there avoids copying those
authorities into main. Heavy provider, artifact, host, and usage work remains in main
behind narrow typed ports.

The coordinator owns only an immutable derived snapshot and its consumer lifetime. It
does not own any project, workspace, retained session, PTY, connection, telemetry,
usage counter, attention, activity, runtime, surface, input, resize, or lifecycle-command
state. Opening Sessions acquires one observation-demand lease; hiding or leaving Sessions
releases it and disposes the coordinator's subscriptions, requests, timers, and recent
sample buffers. Reopening reconstructs a current snapshot from the retained owners, so a
quiet night does not turn the view into an empty state.

Main exposes a renderer-generation-qualified `SessionsObservationPort` as an adapter over
the existing owners. That port is not a store or a coordinator. It registers change
observation before taking the initial snapshot, returns one monotonic revision, and emits
later revisions only to the exact current demand lease. A revision gap, renderer rollover,
or reconnect requires a fresh snapshot. A stale lease, generation, request, or asynchronous
result is discarded.

The projection joins facts with bounded, opaque hvir-owned handles. Project and workspace
IDs may provide presentation identity. An internal terminal handle may resolve to the exact
retained terminal and an internal PTY handle may additionally resolve to one live PTY
instance and renderer generation. Sessions adds no mapping for provider session or
conversation identifiers, artifact locations, raw host paths, or PTY authority; each stays
inside its existing owner. Those values do not enter Sessions IPC, persistence,
diagnostics, DOM attributes, or logs.

Codex App Server and Claude Code hooks are both **unsupported for topology in this pass**.
Neither satisfies the exact native-terminal, content-free, demand-scoped local and SSH
boundary. Consequently the topology child must be deferred rather than inventing a
contract. The global projection, overview, usage, terminal-detail, and ranking children
remain unblocked.

## Owner and reuse inventory

| Fact or resource | Current authority | Reusable seam | Sessions rule |
| --- | --- | --- | --- |
| Registered projects and discovered workspaces | Main `ProjectRegistry` | `ProjectRegistry.state()`, `projectById()`, and the existing `project:state` publication | Reuse the loaded catalog and its display IDs. Do not discover, open, refresh, materialize, or connect anything for Sessions. |
| Host connection | One logical `ProjectHost` through `ProjectHostCatalog`; `ProjectRegistry` publishes the renderer-safe state | `ProjectHost.connectionState`, catalog host-state notification, and `ProjectState` | Display the existing state. A disconnected retained session remains representable; Sessions does not connect it. |
| Retained terminal session | Main `TerminalSessionRegistry` | Existing root-qualified `list()` and exact `get()` are the authority; later projection work may add a read-only snapshot/change port at this owner | Read loaded records only. Do not expose `harnessSessionId`, raw `HostPath`, artifact identity, or a mutation method. |
| Live or exited PTY instance | Main `PtySupervisor` | `get()`, `list()`, `onExit()`, `onSessionIdentity()`, and renderer-generation checks | Adapt only safe liveness and an opaque instance handle. Do not attach an output stream, replay output, spawn, resume, kill, write, or resize for card projection. |
| Provider identity and structured telemetry | Main harness provider registry and the exact `PtySupervisor` entry | Provider capability descriptors, `HarnessSnapshot`, and the current PTY telemetry snapshot | Provider IDs stay opaque data. Providers observe and normalize; projection code never branches on `codex` or `claude-code`. |
| Host-multiplexed live provider observation | Provider-owned `HarnessTelemetryHubRegistry` per `(host, provider)` | Its exact-session subscription and empty-hub eviction | Reuse when its semantics match. A Sessions consumer may add demand; a retained record alone never does. The hub survives only while some named consumer still demands it. |
| Cumulative token counters | Each bundled provider's `usageSnapshots` implementation | Provider-owned artifact qualification and normalization; `nonNegativeUsageCounter()` and safe summation/delta policy | Extract the provider-neutral counter vocabulary and arithmetic narrowly if runtime consumers need it. Do not import the GitHub agent-work ledger or expose `costUsd`. |
| Attention and Working activity | Renderer terminal workspace model and `useTerminalAttentionController` | Existing `TerminalAttention`, `terminalActionableAttentionCount()`, and `terminalWorkingCount()` policy | Observe the current model; never reclassify output or provider turns. Working remains the deliberately imperfect generic input/output/idle heuristic. |
| Materialized terminal workspace and runtime | Renderer `TerminalWorkspaceRuntimeOwner`, `TerminalRuntimeRegistry`, and exact `TerminalRuntime` | Existing snapshot/subscription patterns and runtime identity | Add only a read-only observation port for already materialized runtimes. Projection does not retain or materialize a workspace. |
| Terminal presentation and event delivery | Exact `TerminalRuntime`, `TerminalSurfaceAttachment`, `TerminalEventRouter`, and `TerminalPane` | Existing reparent, visible/hidden presentation, bounded hidden delivery, fit, focus, and disposal behavior | Cards create no surface. Detail borrows the actual current surface through one qualified lease; it creates no pane, PTY, event route, or output copy. |
| PTY input and resize authority | Main `PtySupervisor` plus `RendererResourceScopes` and exact owner generation | Existing `pty:write` and `pty:resize` authorization for the current renderer-owned PTY | DOM placement grants no PTY authority. Only input emitted by the focused actual `TerminalPane` follows the existing route. |

Two narrow extractions are expected when later children need them:

- A main-internal terminal observation port reads `TerminalSessionRegistry`,
  `PtySupervisor`, `ProjectRegistry`, and provider snapshots without exposing their mutation
  APIs or sensitive identifiers.
- A renderer-internal runtime observation and surface-lease port reads exact existing
  `TerminalRuntime` instances without exposing workspace controllers or creating runtime.

Usage counter admission, safe summation, and provider snapshot normalization are one stable
concept. If they move out of the lifecycle-measurement module, both the contributor ledger
and runtime usage sampling depend inward on that provider-neutral concept; the runtime must
not depend on the contributor ledger.

This gate makes no change to Working. Its generic submitted-input/output/idle classifier
can sometimes be wrong, and Sessions must present that limitation rather than claiming
provider certainty. If product testing finds a blocking case, a focused follow-up belongs
to the existing renderer attention owner and ADR-019 policy.

## Projection and demand contract

### Snapshot and notification flow

1. The visible Sessions route declares one consumer to `SessionsProjectionCoordinator`.
2. The coordinator acquires a main observation lease qualified by renderer owner and
   generation plus a new demand generation. Main registers source notifications before
   capturing the initial safe snapshot so no transition can fall between snapshot and
   subscription.
3. The coordinator joins that snapshot with the current renderer runtime/attention
   snapshot by opaque terminal handle. A missing renderer fact means dormant,
   unmaterialized, unavailable, or stale according to the main fact; it is never an
   instruction to materialize.
4. Main source changes publish a monotonic revision to that exact lease. Renderer runtime
   changes publish through the existing external-store pattern. Repeated facts are
   deduplicated; gaps request a new current snapshot rather than guessing.
5. Leaving or hiding Sessions aborts in-flight snapshot and sample work, disposes both
   subscriptions, increments the demand generation, and drops Sessions-only recent
   samples. Main releases the renderer-scoped observation resource even if renderer
   cleanup cannot send a final message.

Project catalog, retained-session, PTY lifecycle, connection, and renderer runtime changes
are event-driven. They require no projection tick. Only the usage feature may request a
bounded cadence while visible; that cadence is selected and tested in its own child.
Provider freshness remains the `HarnessSnapshot` provenance and freshness contract rather
than a Sessions timer.

### Quiet hidden behavior

After the last Sessions consumer disappears, Sessions owns no provider subscription,
remote command or channel, helper process, timer, animation frame, chart tick, sample
buffer, IPC subscription, or Ghostty update loop. Shared provider telemetry may remain
alive only because its existing terminal consumer still declares demand. Hiding Sessions
does not stop that other consumer and does not stop a PTY.

The coordinator stores no overnight history. Retained sessions and registered workspaces
remain available from their existing owners when the view reopens. Cumulative usage can
be sampled again from an exact provider artifact; the recent moving window begins again
without pretending to have observed the hidden interval.

Opening Sessions never:

- materializes a terminal workspace or `TerminalRuntime`;
- connects an SSH host or opens a new transport;
- starts, resumes, replaces, retries, or closes a PTY;
- starts provider observation for every retained session;
- creates a terminal pane or surface for a card; or
- parses PTY output, terminal cells, titles, paths, or ambient latest provider state.

### Usage demand and retention

A main-owned `HarnessUsageDemandController` accepts exact, renderer-qualified demand
leases. It resolves the provider and host behind the existing registry and `ProjectHost`,
runs artifact reads and normalization off the renderer thread, and reuses the telemetry
hub when a live snapshot already has the required semantics. It owns provider
subscriptions, sample timers, abort controllers, and any host resource created for that
demand. Removing its last lease disposes them.

`SessionsProjectionCoordinator` owns the bounded in-memory recent-sample buffer because
that buffer exists solely for Sessions presentation. It accepts only current cumulative,
normalized counters with provenance and observation time. It performs safe provider-neutral
arithmetic, not artifact parsing. It discards the buffer on hide, renderer rollover, or
dispose. Process restart and view reopen therefore reset the moving window. Exact counter
names, cadence, window size, aggregation, chart tuning, and card copy remain decisions for
the usage children.

The runtime vocabulary is token usage, never monetary cost. Neither the runtime
`HarnessUsageFacet.costUsd` compatibility field nor GitHub agent-work planning and delivery
records are a Sessions source.

Local and SSH sampling use the same `ProjectHost` port. Demand against a disconnected host
returns an unavailable fact and releases its request resources; it does not connect or
retry the host. Only the existing explicit host connection lifecycle can make a later
visible demand eligible for a new sample.

## Exclusive terminal-surface lease

The exact `TerminalRuntime` remains the session surface owner. Its
`TerminalSurfaceAttachment` grants at most one attachment lease at a time; the
`TerminalWorkspaceRuntimeOwner` may resolve a safe terminal handle to that existing
runtime but may not create one to satisfy Sessions. The lease moves the actual retained
`TerminalPane` surface between its workspace container and one Sessions detail container.
It never creates a preview, second terminal pane, second PTY, copied transcript, provider
UI, or per-card surface.

Every surface operation is qualified by all of:

- the opaque hvir terminal handle;
- the current live PTY instance handle;
- the renderer owner and generation;
- a monotonic surface-lease generation; and
- the exact container object currently owned by that lease.

The attachment owner hides before reparenting, reapplies the requested presentation only
after the current container is installed, and uses the existing pane's fit, redraw,
animation, throttling, and hidden-output behavior. Focus, resize, and direct terminal input
are accepted only when every qualifier is current and that actual pane is visible and
focused. PTY write and resize continue through the existing current renderer/PTY generation
checks; the surface lease conveys no independent input capability.

Navigation away, Sessions hiding, window blur, renderer rollover, host disconnect, PTY
replacement or exit, terminal close, workspace removal, and owner disposal hide and revoke
the lease. A normal navigation return may acquire a new lease and restore the surface to
the exact workspace container if that workspace and runtime are still current. A stale or
removed workspace leaves the surface hidden under its runtime owner; it never reparents to
an approximate container. Cleanup is idempotent and a late attach, fit, focus, resize,
input, or return result from an expired lease is ignored.

When Sessions detail is absent, hidden, or in an unfocused window, it owns no Ghostty
render, update, fit, or animation loop. The PTY and bounded hidden output route remain live
under their existing owners.

The lease contract, controller, view, routing, input, focus, resize, and cleanup contain no
provider-name branch. Codex and Claude are not the architecture. Any current or future
bundled provider, Bare Shell, or Custom profile can use the same detail when the projection
truthfully reports that one exact live `TerminalPane`/runtime/PTY capability exists.
Provider-specific launch, recovery, telemetry, and topology behavior remains behind the
provider registry. This does not authorize a public plugin SDK or new extension boundary.

## Provider topology feasibility

The evaluated status vocabulary is:

- **supported**: exact, read-only, content-free, demand-scoped, and safely revocable for
  the native hvir terminal on both local and SSH hosts;
- **unavailable**: the qualifying contract exists, but the current bounded environment
  cannot exercise or verify it; and
- **unsupported**: the documented contract itself violates an accepted boundary or
  requires a prohibited architecture.

| Candidate | Exact correlation and fields | Lifecycle and failure | Process, configuration, and hosts | Result |
| --- | --- | --- | --- | --- |
| Codex App Server | Exact thread read plus parent/ancestor filters and subagent source kinds | Runtime state covers threads loaded by that App Server; an independently active native TUI appears `notLoaded` | Local or SSH use requires a separate App Server and a TUI launched through `--remote`; server/transport failure would become part of the terminal lifecycle | **Unsupported** |
| Claude Code hooks | `session_id`, `agent_id`, and `agent_type` correlate exact start/stop events | No complete content-free failure/interruption contract; the stop event always includes response and artifact-path fields | Inline `--settings` is launch-scoped rather than persistent, but cannot be revoked on Sessions hide; SSH also requires a safely cleaned remote event sink that is not available | **Unsupported** |

### Codex App Server — unsupported

The current [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
provides exact thread reads, runtime status, loaded-thread notifications, subagent source
kinds, and experimental exact `parentThreadId`/`ancestorThreadId` filters. Those fields are
sufficient for an app-server-owned client to model descendant threads.

They do not observe the runtime of an independently launched native TUI. App Server is a
long-lived process with its own loaded-thread set. The documented way to connect the TUI
is to launch `codex app-server` and then launch the TUI with `codex --remote` against that
server. Doing so solely for Sessions topology would make App Server part of every Codex
terminal's launch, transport, authentication, failure, and recovery contract. On SSH it
would additionally require a remote process plus a protected socket or forwarded transport.
That is precisely the process and launch change this gate excludes.

The content-free live proof ran on macOS arm64 with `codex-cli 0.149.0`. A bounded temporary
stdio App Server performed only `initialize`, exact `thread/read` with turns omitted, and
an exact-parent `thread/list` capped at one result. It returned the exact identifier match
and accepted the parent filter, but reported the concurrently active exact Codex session
as `notLoaded`. The proof emitted only booleans, the status enum, protocol name, and bound
result; it emitted no provider identifier, path, title, preview, turn, item, prompt,
response, reasoning, or raw record. The process was terminated immediately after both
responses. It did not start, resume, fork, steer, archive, subscribe to, or otherwise
mutate a thread.

This is decisive rather than an environment-only absence: exact persisted correlation is
available, but live native-TUI topology is not. Codex topology remains unsupported until
the existing native TUI exposes a provider-owned, read-only attachment that shares its
live descendant/runtime state without adding App Server as a Sessions-only process or
replacing the TUI launch contract.

### Claude Code hooks — unsupported

The current [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)
defines exact `SubagentStart` and `SubagentStop` events. Both carry the parent
`session_id`, unique `agent_id`, and `agent_type`; stop additionally carries the subagent
artifact path and final assistant response. The local `claude 2.1.237` CLI also accepts an
inline `--settings` JSON value for one launch, so hook configuration need not be written to
a user or repository settings file.

The source still fails the accepted boundary:

- `SubagentStop` unconditionally delivers provider response content and transcript paths;
  hook configuration has no documented field projection that can make the event source
  content-free before an hvir-owned handler receives it.
- Launch-scoped hooks stay active for the whole Claude session. Hiding Sessions cannot
  remove one hook from the live TUI, so later subagent events continue to spawn hook work
  after the last Sessions consumer disappears.
- The documented start/finished pair is not a complete content-free failure,
  interruption, resume, and disconnect protocol.
- Hooks execute wherever Claude Code runs. An SSH implementation would need an event sink
  or executable on the remote host and a cleanup contract that survives transport loss.
  No qualifying service-free, safely revocable design is documented or currently owned by
  `ProjectHost`.

No live Claude subagent was created for this evaluation. Creating one solely to fire hooks
would alter provider conversation state and expose the response-shaped stop payload, while
the bounded proof requirement was already satisfied by the non-mutating Codex read. Static
CLI and official-contract inspection was enough to classify the boundary as unsupported,
not unavailable.

Claude topology may be reconsidered only if the bundled provider can attach and detach an
exact current-session observer on demand, select a content-free event schema before hvir
receives it, report a complete lifecycle, and cleanly revoke the same design through
`ProjectHost` on local and SSH hosts. Persisting or silently editing settings, scanning
subagent artifact directories, parsing transcripts, or accepting raw hook payloads is not
a substitute.

### Epic effect

No evaluated provider qualifies, so provider topology and per-subagent usage attribution
must be deferred from the current epic. Later work must not infer relationships from
paths, terminal titles, timing, current directories, ambient latest state, or provider
content. This result does not block the global Sessions projection, overview, per-session
usage, live terminal detail, or moving session-usage ranking.

## Verification expectations for later children

Pure tests own projection joins, revision gaps, demand reference counting, counter
arithmetic, bounded retention, qualifier matching, idempotent disposal, and late-result
rejection. Immediate main adapter tests own provider, PTY, registry, and host snapshot
translation without raw identity leakage. Renderer tests own runtime observation and one
exclusive surface lease.

Production-composed Electron evidence owns route enter/leave, hidden and unfocused quiet,
renderer rollover, actual Ghostty reparenting, focus, direct input, fit/resize, PTY exit and
replacement, safe workspace return, and accessible detail focus. Local and real-SSH
evidence use the same projection and cleanup contract; SSH acceptance additionally proves
that merely opening Sessions creates no connection, remote helper, or per-session channel.

This architecture gate itself changes documentation only and therefore adds no runtime
observer, process, timer, buffer, IPC channel, surface, or test fixture.
