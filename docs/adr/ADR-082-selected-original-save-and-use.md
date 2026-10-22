# ADR-082: Selected-original Save and use

> Lifecycle: Active
> Supersedes: [ADR-060](ADR-060-public-skillager-advanced-exposure.md) | partial | Separate import and adoption decisions for an explicitly selected unsaved native original.
> Supersedes: [ADR-079](ADR-079-selected-original-save-and-accept.md) | partial | Mandatory separate replacement decision when the human explicitly chooses the combined Save and use task.

## Context

Using a native project skill as a managed Full or Stub copy requires preserving its
complete original in the personal library. Requiring the human to discover and finish
a separate import task adds an unnecessary decision to that explicit outcome.

## Decision

Offer one human-only Save and use task for an exact selected local native original.
Skillager owns the complete public import-placement manifest and opaque token: original
occurrence, complete file identities, library destination and initialization or
reconnection, acceptance, chosen agent/mode, and every project replacement effect.
Preview grants no canonical acceptance and writes no library or catalog state. All
files remain optionally inspectable through the existing independent source reader.

The extension presents the complete decision and revalidates it before one public CLI
mutation. Its distinct `save-and-use-copy` action declares delete and replace effects
and is unavailable to agents. Skillager preserves its separate import, acceptance,
preservation and publication owners, locks and protections. Core acquires no Skillager
policy, parser, scanner or workflow. Existing action, argument and output bounds apply.

Report canonical save and project replacement separately. If replacement fails after
saving, retain the saved canonical version and offer a fresh explicit replacement task.
Partial or missing replies stay with the existing pending-operation owner; public
current-state observation never proves historical completion. Never replay, infer
rollback, delete saved content, or silently fall back to chained operations.

Standalone Save still preserves the original unchanged. Already-preserved originals
use their existing complete adoption plan. Unsupported installed CLI contracts receive
an update instruction without disabling reading or independent tasks. No global or SSH
compound adoption, force, canonical deletion or source/future-version approval is added.

## Consequences

The common conversion has one decision with complete optional inspection. A canonical
save can survive failed project replacement, so stage facts and recovery paths remain
visible. First-library identity is prospective until the CLI actually initializes it.

## Rejected alternatives

- Chaining import and adoption in hvir loses one complete domain decision.
- Treating prospective canonical metadata as acceptance creates false authority.
- Rolling back a successful save discards useful preserved content.
- Requiring a separate pending-copy finalization adds an everyday decision.
