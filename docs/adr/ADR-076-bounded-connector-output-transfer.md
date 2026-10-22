# ADR-076: Bounded connector output transfer

> Lifecycle: Active
> Supersedes: [ADR-051](ADR-051-approved-finite-connector-execution.md) | partial | Connector output pages sharing the general 16 KiB reply envelope and unrestricted repeated public page delivery.

## Context

Small connector pages can exhaust the guest's message allowance before an ordinary result is
read. Pacing small pages alone cannot drain four maximum, heavily JSON-escaped receipts within
the fixed retention period. Retained-byte limits do not bound repeated delivery of the same page.
Authors need an ordinary reader without package-specific pacing or a second native execution.

## Decision

Only the existing connector execution owner returning an admitted `connector.output` page may
produce a complete encoded result envelope up to 512 KiB. Target 128 KiB of raw UTF-8 per page;
adjust character boundaries and halve until the complete reply, including bounded metadata and
warnings, fits. All requests and other responses retain 16 KiB. Payload tags confer no exception.
Both independent preload/main 30-message-per-second guards remain authoritative.

The existing receipt charges every successful nonempty public page against an aggregate delivered
raw-byte allowance equal to its retained stdout plus stderr. Repeated and overlapping reads cost
the same bytes. An over-budget page refuses in full. Empty EOF replies still consume ordinary
message capacity. Reads neither change retained bytes nor renew expiry, authorization or execution
capacity. Main-owned capture custody remains available independently until release, revocation or
the unchanged 30-second expiry. All other ADR-051 authority and capacity rules remain active.

One public browser guest client owns bounded request correlation, cancellation, visibility and
admitted-action lifetimes. Its single monotonic rolling window counts every outbound message at
24 per second, including hello, cancellation, release and action results. A 50 ms
replenishment margin retains short immediate bursts while providing modest IPC-clock headroom;
it cannot guarantee a receiving fixed window after arbitrary stalls. Queued plus outstanding
requests and unsent cancellation obligations share eight slots. At most four admitted actions
retain one result obligation each; hello is emitted once. Five output reads to one ordinary/control
message when both classes wait provide fair FIFO progress within each class. Local cancellation
retires queued work immediately; never-submitted requests send no cancellation. Disposal retains
no scheduled work. Main remains the authority for hidden finite actions and physical teardown.

A separate bounded stream reader validates the expected receipt/result, exact UTF-8 byte progress,
complete EOF and a caller-selected maximum no greater than the native output ceiling. It returns
complete data without interpreting domain success or retrying execution. Callers retain explicit
release and capture-before-release ordering. Skillager retains its schemas, workflows, frequency
policy and smaller management response bound. Presentation helpers retain only presentation.

The shared browser assets are copied into the existing offline starter's complete captured asset
graph. Extension packages consume those assets or bundle the same public source. Raw bridge
callers remain supported under the documented byte and flood limits; they receive no hidden queue.

## Consequences

A 650 KiB stream needs about six nominal or eleven worst-escaped pages. Worst JSON expansion
leaves at least 64 KiB minus three UTF-8 boundary bytes per non-final page; four maximum receipts
need at most 264 reads, approximately 13.2 seconds of pacing at twenty reads per second, or
13.9 seconds including replenishment headroom. Timer clamping can make hidden execution slower.
These are sizing calculations, not performance guarantees for a stalled machine. Real guest/IPC/native evidence
must establish usable transfer and responsiveness. Quantitative performance remains subject to the
existing controlled-machine method.

Public data delivery from a fixed live receipt set cannot exceed its retained byte count, bounded
globally at 32 MiB. Repeated partial inspection can exhaust that allowance before a subsequent full
read; callers should retain data they already read and release promptly. Larger replies impose
bounded serialization cost while preserving finite authority and resource ownership.

## Rejected alternatives

- Exempting output reads from flood guards permits repeated-page amplification.
- Pacing 8 KiB pages cannot serve all supported escaped/concurrent output within the fixed lifetime.
- A separate high-rate lane duplicates classification and scheduling policy in both guards.
- Extending expiry, unbounded whole-stream replies, or replaying execution changes authority and
  capacity to hide a transport defect.
- A universal SDK, second receipt store or package-specific limiter duplicates existing owners.
