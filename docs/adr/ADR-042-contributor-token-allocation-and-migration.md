# ADR-042: Contributor token allocation and historical reconciliation

> Lifecycle: Active
> Supersedes: [ADR-041](ADR-041-deterministic-contributor-status.md) | partial | Single-issue session assignments, cumulative-only attribution, historical exclusion, optional planning capture, and Recorded tokens/Token scope field retirement policy.

## Context

Contributor planning can produce several issues in one session. Maintainers need observed
planning, non-planning, and total usage without losing historical counts or counting one
session or epic rollup twice. Provider counters do not always support a reliable phase split.

## Decision

Keep collection, allocation, aggregation, and Project projection in deterministic contributor
tooling. Provider-specific observation and normalization remain behind the existing provider
boundary. Skills select issue identities and explicit planning, implementation, or unknown
attribution; they neither calculate shares nor manage checkpoints. Implementation includes all
non-planning activity, including reviews, corrections, coordination, and acceptance work.

Planning handoffs request capture or report a concrete unavailability reason. A planning session
ends at its issue-creation handoff, including a batch created together. Continued sessions allocate
only newly observed usage. Planning batches divide integer deltas equally, with remainders assigned
in ascending issue-number order. Immutable private counter intervals preserve prior assignments;
public receipts carry only opaque contribution identities, issue numbers, phase, and token counts.
A durable interval precedes publishing any share. Concurrent claims fail visibly and interrupted
publication replays the same shares. Counters that decrease are unavailable, never negative usage.

The canonical Project exposes Planning tokens, Implementation tokens, and Total tokens. A mixed
session without a reliable split contributes only its total; its phase counts remain unknown.
Fully attributed totals equal the two phase counts. Old cumulative receipts remain readable with
unknown phase, and later observations exclude their already recorded counter range.

Historical Lifecycle tokens is already a rollup and is authoritative. Migration preserves original
field values and exact covered receipt maxima in immutable evidence before overwriting or deleting
source fields. Epic-owned historical contributions exclude direct-child rollups; ongoing epic
aggregation adds its own contributions and each native direct child's once. Unproven overlap,
incomplete relationships, and discrepancies block destructive reconciliation. Explicit manual
corrections require documented supporting evidence. Missing evidence is never fabricated.

Migration plans are reviewable and mutations revalidate live sources. Interrupted receipt appends,
field transfers, and deletion are retryable using saved evidence. Future capture adds contributions
above covered receipt maxima, preserving migrated usage. After reconciliation, delete only exact
retired measurement fields; retain the three token fields, Kind, Status, and native fields.

## Consequences

Contributor reporting retains a small private allocation history because batch attribution and
retry safety require counter boundaries. It introduces no application telemetry or new provider
access path. Approximate observed usage does not claim all unrecorded work. Historical ambiguity
can require maintainer evidence before source fields can be removed. GitHub relationships and
protected merge remain authoritative; the acceptance rules of ADR-041 remain unchanged.

## Rejected alternatives

- Adding cumulative observations on every capture, which duplicates prior allocations.
- Agent-calculated shares or manually maintained routine checkpoints.
- Adding Lifecycle tokens to its component phases or adding epic rollups to child rollups.
- Guessing overlap or replacing missing counters with zero to force migration completion.
- Deleting source fields before preserving evidence and verifying their replacement values.
