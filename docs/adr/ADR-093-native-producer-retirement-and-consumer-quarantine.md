# ADR-093: Retire producer writes independently of quarantined consumers

> Lifecycle: Active
> Supersedes: [ADR-087](ADR-087-indeterminate-native-presentation-quarantine.md) | partial | Conditional producer-lease release after a proved writer-retirement fence while consumer resources remain quarantined.

## Context

A late consumer can make complete GPU read ownership unknowable even though main owns
an authenticated independent OS reference. That reference preserves allocation lifetime,
but does not prevent the producer from overwriting a reusable target. Holding the single
producer lease indefinitely protects the consumer while preventing the same parser from
exporting fresh frames. Consumer read completion and producer writer retirement are
separate physical facts.

## Decision

Permit producer-lease retirement only when the importer retains an authenticated,
validated, unreleased independent receipt associated with the exact held native state,
process epoch and source lease. Preserve the old receipt, import or texture and global
import credit in quarantine regardless of later consumer callbacks. The existing maximum
of three pending, held or quarantined imports is unchanged.

A host-qualified request identifies the exact held lease. Begin acknowledges admission,
not completion. The owning renderer command must complete all GPU writes, join completion
callback tails and retire every writable target alias before acknowledging that request.
The producer hold remains set until the caller receives that exact positive result and
successfully performs the original source release. Pending, failed, malformed, timed-out
or otherwise unknown results retain the guard and lease. Actor teardown authorizes cleanup
only after writers and callbacks joined and the surface ended; it is never same-parser
recovery. A process exit cannot be interpreted as successful producer recovery.

After positive retirement and release, the same live parser may export a genuinely fresh
target pool. Remove only the matching producer-fault reason; newer faults and other native
epochs remain blocked. Revalidate current view ownership, visibility, target and geometry
before presenting. Availability and frame scheduling resume only after a fresh authorized
frame succeeds. Hidden or disposed views remain hidden, and a failed receiver retains its
ordinary rebind requirement. Renderer APIs, TerminalPane, PTY identity, parser contents and
engine selection do not change.

All other quarantine and fallback rules remain authoritative. This mechanism does not
prove consumer completion, reclaim quarantined credits, free uncertain consumer resources,
select pixel fallback or permit target reuse based on receiver destruction or an old
high-level final-reference callback.

## Consequences

A bounded consumer quarantine need not permanently stall the same producer. Retained old
resources consume their existing credits and may still exhaust admission; the new producer
pool also has a resource cost. The private native integration requires an exact supported
retirement contract and platform evidence. Unknown ownership fails closed rather than
reconstructing terminal state or weakening resource bounds.

## Rejected alternatives

- Releasing the producer after receiver death or a timeout: proves neither write retirement
  nor immutability for a late consumer.
- Treating a retained OS handle as immutable: allocation lifetime does not eliminate writable
  aliases or queued GPU work.
- Returning the old import credit after writer retirement: future or outstanding consumer
  reads remain unresolved.
- Replaying parser output or switching engines: changes authoritative state ownership to
  recover a presentation failure.
- Keeping every producer permanently stalled despite an exact writer fence: unnecessarily
  couples independent writer and consumer lifetimes.
