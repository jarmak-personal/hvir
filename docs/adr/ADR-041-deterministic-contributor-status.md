# ADR-041: Deterministic contributor status and approximate session totals

> Lifecycle: Partially superseded
> Superseded by: [ADR-042](ADR-042-contributor-token-allocation-and-migration.md) | partial | Single-issue session assignments, cumulative-only attribution, historical exclusion, optional planning capture, and Recorded tokens/Token scope field retirement policy.

## Context

Contributor reporting needs three facts: tokens, Project state, and acceptance state.
Phase forecasts, precision clocks, route histories, first-pass classifications, and manual
ledger reconciliation consume agent context without improving those statements. Exact
per-phase effort is not the maintainer's requirement; useful session-attributed totals are.

## Decision

Repository tooling reports explicit facts without model calls or prose interpretation.
One provider session belongs to one selected issue; an epic coordinator belongs to its epic.
A private durable local assignment gives that session one issue and a random public receipt
key. It contains no transcript or counters. Captures append small immutable receipts of the
provider-observed cumulative normalized token total. Each key contributes its maximum observed
total once, so repeated, stale, or concurrent captures cannot add a whole session twice.
An assignment to another issue is a visible mismatch, not a request to reconstruct phases.

Totals are observed session-attributed estimates since this accounting change, not exact
issue effort or all-time totals. Unrecorded sessions are unknown. Provider-native missing
counters are not zero; incomplete snapshots do not produce totals. Private assignments must
remain on the originating machine for recapture. Losing that state or copying a session to
another machine loses its deduplication identity; automatic cross-machine recovery is not a
feature. No provider session ID, artifact path, transcript, or derived public session locator
is published.

Capture owns receipt append and the selected issue/direct parent's token projection. Reporting
aggregates one issue's receipts and, for a root epic, each native direct child's receipts once.
It never sums issue-owned totals with already aggregated epic totals. Append uncertainty is
retryable with the same assignment; projection failure cannot roll back a receipt. No agent
constructs records, chooses keys, manages checkpoints, or sequences reconciliation commands.

Retire contributor phases, forecasts, route history, precision timing, first-pass accounting,
and their active writers and fields. Existing v1 issue comments and Project values remain
historical, excluded from new totals. A deliberate one-off Project transition renames retired
fields with a Legacy prefix and provisions only Recorded tokens and Token scope. Old writer
commands are not supported after this transition. Native Status and Kind remain unchanged.

Project state, required-check results, native review state, merge requests, and merge outcomes
are separate facts. Verified handoff is readiness, not acceptance. Explicit maintainer invocation
of hvir-merge-pr supplies approval; GitHub's protected merge completes final delivery. A later
read cannot recover private invocation provenance and reports approval unknown. A child merge
into an epic is integration, not final epic acceptance. No parallel approval ledger is added.
Successful authorized issue startup sets that selected issue In Progress through the existing
Status owner. Dry-run and failed setup do not change Status; no parent state is inferred.

Provider qualification and normalization stay behind bundled providers. Contributor one-shot
reads use a finite deadline and bounded record/deduplication memory rather than the live
observer's cumulative byte limit; incomplete reads never yield totals. Application telemetry
defaults and public product behavior remain unchanged.

## Consequences

Agents retain implementation and review judgment, while ordinary reporting is deterministic.
Session attribution may include unrelated discussion and omit unrecorded work; reports label
that limitation instead of claiming precise effort. Local assignment and a tiny receipt format
remain because deduplication requires identity, but no measurement lifecycle engine remains.
The existing allowlisted private filesystem owner keeps its historical
`agent-work-checkpoint-store.mts` filename with an entirely replaced session-assignment API;
this does not retain checkpoint behavior or widen native filesystem exemptions.

## Rejected alternatives

- Session-only reports: they discard the maintainer's useful issue and epic totals.
- Exact phase deltas and model-operated records: unnecessary precision and coordination cost.
- Adding cumulative snapshots repeatedly: double-counts recaptured sessions.
- Public hashes of provider identities or ambient transcript recovery: unnecessary correlation
  and private-data exposure.
- Inferring acceptance from Done, issue closure, green CI, review sentiment, or silence.
- Deleting historical evidence or mixing old phase totals into new session receipts.
