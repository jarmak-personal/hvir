# ADR-087: Preserve terminal state through indeterminate presentation failures

> Lifecycle: Active
> Supersedes: [ADR-086](ADR-086-native-terminal-state-and-presentation.md) | partial | Native presentation failure recovery and resource lifetime after indeterminate texture import or delivery.

## Context

Electron can report a shared-texture delivery timeout before a late renderer
consumer has been created. Its high-level final-reference callback may then lack
that consumer's GPU creation sync token. A receiver disappearing or a callback
firing does not establish that this source can safely be overwritten. A native
import may also throw after GPU work has started without returning a releasable
handle. Parser destruction would turn a presentation failure into loss of the
user's authoritative terminal state.

## Decision

Treat indeterminate import and delivery failures as bounded presentation loss.
Revoke the view, stop demand, and show the terminal as unavailable. Retain the
immutable source lease, received OS reference, returned main import if present,
and import credit for the application lifetime unless complete physical release
can be proven. Neither receiver destruction nor the incomplete high-level callback
is such proof. The importer admits at most three pending, held, or quarantined
resources; replacing an attachment does not reset that bound or unblock an
indeterminate source.

Keep the same native parser accepting authoritative output, queries, and applied
geometry. Its held source may keep drawing quiescent. Ordinary presentation
failure does not retire that parser or switch engines. Explicit terminal close
may retire parser state independently while uncertain physical references remain
owned through application shutdown.

Only a rejection proven to precede GPU import can select bounded native pixel
compatibility on the same parser and PTY. For the selected Electron adapter, the
explicit GPU-unavailable rejection before CreateSharedImage is that boundary.
An arbitrary import exception, delivery failure, timeout, or context loss does
not authorize automatic recovery from partial replay or source reuse.

Successful transfers retain their ordinary producer/consumer completion fences.
Logical detach grants replacement authority without waiting indefinitely for a
slow successful consumer; the old resource remains owned and may temporarily
backpressure its replacement. Unknown delivery has the stricter quarantine above.

## Consequences

Terminal output and parser state survive a presentation failure, and no uncertain
GPU consumer observes overwritten pixels. Resource retention is finite and
explicit, at the cost of unavailable presentation and resources held until
application shutdown. Cutover must explicitly retain or accept this limitation;
it cannot be counted as successful pre-shutdown reclamation or transparent
compatibility recovery. A future independently leased export resource or a
complete consumer-completion mechanism may replace this decision when justified
by evidence. Terminal-related decisions remain reviewable as the environment changes.

## Rejected alternatives

- Destroying the parser on presentation failure: loses authoritative state while
  its PTY may still be alive.
- Reusing the source after receiver destruction or the old callback: does not
  prove GPU completion for a consumer created after the timeout.
- Treating every import exception as safe pixel fallback: some failures may occur
  after resource import begins and return no usable completion handle.
- Adding a copy pool solely to recover this case now: expands native lifetime
  machinery before a bounded unavailable outcome is accepted or measured.
