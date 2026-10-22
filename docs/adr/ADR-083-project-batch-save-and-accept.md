# ADR-083: Project batch Save and accept

> Lifecycle: Active
> Supersedes: [ADR-079](ADR-079-selected-original-save-and-accept.md) | partial | Limiting standalone Save and accept to one selected project original.

## Context

Saving useful project skills separately repeats the same library decision. Project-native
inventory can span several browser pages, and duplicate or already-saved occurrences must
not become new canonical copies merely because their names look different.

## Decision

Offer one human-only Save project skills task with an explicit bounded selection from the
whole selected local project's native inventory. Skillager supplies metadata-only eligibility,
complete discovery status, duplicate and existing-copy identities, and the exact batch review.
The extension never derives import eligibility from the visible page, search, names or private
catalog files. Incomplete discovery remains visible; a known subset is never called the whole
project.

One decision saves and accepts all selected versions through one public batch operation.
Skillager owns complete file identities, scanner and lint gates, library identity/history,
initialization effects, collision refusal, opaque confirmation tokens and per-item outcomes.
The extension revalidates the complete public review before dispatch. Changed selection,
source, destination or library invalidates the decision before effects. Files remain optionally
inspectable through independent source-reader grants, without a mandatory visit checklist.

The extension-local contract, operation and reconciliation owners compose existing finite CLI,
action admission and pending-operation capabilities. Core gains no Skillager policy. Current
manifest, action-input, argv, response and source budgets apply. An unsupported public contract
explains how to update Skillager while preserving reading and independent tasks.

Project originals, source approvals, exposures and future canonical versions are unchanged.
No automatic import, automatic canonical update, agent acceptance, SSH import, force, overwrite
or canonical deletion is added. ADR-082's combined replacement task remains separate.

A batch can partially complete. Preserve exact accepted, failed, skipped and unknown outcomes
and retain the admitted raw report through existing bounded pages. No automatic retry, inferred
rollback or re-saving accepted items is allowed. Current-state reconciliation observes only
exact destinations and library registration; it never establishes historical completion.
Pending initialization and destination overlap remain protected by the existing operation owner.

## Consequences

The everyday save flow has one decision while preserving optional complete inspection and
truthful per-item results. Large selections require smaller explicit batches under existing
bounds. Cancellation before dispatch writes nothing; revoked or replaced contexts cannot gain
late authority over another project.

## Rejected alternatives

- Automatically importing discovered skills conflates discovery with acceptance.
- Looping independently confirmed single imports adds repeated decisions and loses one complete
  domain review.
- Guessing duplicates from names or silently updating existing copies changes canonical content
  without the selected decision.
- Copying to pending first adds a separate finalization step to an already explicit acceptance.
