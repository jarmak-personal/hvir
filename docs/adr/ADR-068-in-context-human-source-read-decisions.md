# ADR-068: In-context human source read decisions

> Lifecycle: Active
> Supersedes: [ADR-057](ADR-057-selected-extension-source-reading.md) | partial | Settings-only application-local read-only root decision surface only.

## Context

An ordinary extension can report its personal-library location through an approved public
CLI. Requiring the human to type that location again in Settings interrupts explicit
instruction reading. The reported location is a proposal and conveys no filesystem authority.

## Decision

A current visible ordinary human application view may request its declared application-local
read-only source scope while explicitly selecting instructions. Main rejects updater,
agent, restricted and action origins independently of request data. Workspace and delivery
scopes retain their existing explicit owners and decision surfaces.

A source-specific request adapter reuses the existing source-approval owner's canonical
host-qualified preparation, finite tokens and persistence. Trusted workbench UI displays the
actual canonical root and supplies the human decision. Guests receive neither approval tokens
nor an approve capability. An existing valid grant for that unchanged canonical scope needs
no repeat decision. Metadata browse, refresh, focus and reported paths grant no access.

Bind the request to its current view, renderer, installation, declaration, activation and
request lifetime. Cancellation, hiding, closure, revocation and replacement retire the UI and
prepared token; physical preparation and persistence retain their owning admission until they
settle. Revalidate before persistence and selected-current reads. An interrupted submitted
write does not imply rollback. No second canonicalization policy, grant store or generic prompt
framework is introduced.

The package owns public CLI support, personal-library root/UUID truth, changed-library
reconciliation and setup guidance. It observes a supported connected library automatically
and delegates explicit creation to the existing CLI-default initialization action. Main
contains no Skillager parser. Missing or unsupported CLI guidance can be copied to an agent;
it performs no automatic installation or new terminal injection.

ADR-057 continues to govern selected-current receipts, confined assets, safe rendering,
application/workspace separation and denial of instruction bodies to agents and actions.

## Consequences

The first explicit read needs one understandable root decision without manual path entry.
Trusted request transport adds a bounded UI lifetime, while reading and content acceptance
remain independent. A changed library requires fresh package-owned identity reconciliation;
an old reported location cannot silently authorize its replacement.

## Rejected alternatives

- Automatically granting a CLI-reported root conflates native execution with file access.
- Guest-callable approval or deferred arbitrary roots remove trusted current-human admission.
- A second grant store, generic prompt registry or core Skillager parser duplicates ownership.
- Automatic dependency installation or terminal injection exceeds the browsing correction.
