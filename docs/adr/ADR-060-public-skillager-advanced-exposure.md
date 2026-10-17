# ADR-060: Public Skillager advanced local exposure

> Lifecycle: Active
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Exclusion of native adoption from local management; complete public preservation-backed adoption is permitted by this decision.

## Context

Related skills may share a Router, change membership, return to individual Full/Stub copies,
or replace an existing native original with a Skillager exposure. These choices affect several
files, source versions and preservation relationships. Everyday copy plans cannot authorize
only a subset of those effects. The extension already consumes eight exported semantic actions.

## Decision

Keep advanced selection, review, public CLI consumption and reconciliation in extension-local
exposure owners. Skillager owns complete Router/tag membership, source UUID/version, lineage,
native preservation, opaque token validation, staging and all physical effects. Core acquires
no Skillager parser, scanner, approval algorithm, source policy or recovery workflow.

Export one `change-exposure` action for explicit direct-copy Update and advanced Group,
Set members, Ungroup and Adopt requests. Declare both delete and replace effects for that
semantic action, and consume D4 caller provenance and D6 standing or confirmed authorization.
Retain separate create-only Add and delete-only Remove. Update current consumers directly;
there is no old action alias and no increase to the eight-action or 8 KiB argv ceilings.
A complete selection that cannot fit refuses before apply; never truncate or split a plan.

Human advanced review presents the selected agent and exact local project, complete desired
membership, explicit departing-member Full/Stub/Remove choices, selected standalone replacements
and every affected file. Technical identities, metadata and native plan remain inspectable.
A single decision binds the complete fresh public token. Revalidate it before dispatch and
let the CLI enforce it under mutation authority. Native adoption requires a supported exact
origin-to-canonical preservation relation; uncovered original bytes/modes, modified, blocked,
unmanaged or pinned conflicts and shared tags retain public domain protections. No force,
pin override, canonical deletion, global or SSH advanced management is introduced.

Consume complete public per-target outcomes, including nonzero partial results and retained
recovery paths. Unknown or malformed completion keeps its original action, caller class,
workspace, library and complete plan in the existing ephemeral pending-operation owner.
Target intersections block only dependent work. Never retry mutations, delete recovery objects,
claim rollback from an exit code, or clear uncertainty because another operation succeeded.

Reconciliation observes the recorded request through public preview first. Retained staging
and unresolved protection failures refuse acknowledgment with ordinary tools/public CLI repair
guidance. A complete fresh plan can establish safe next-operation facts. For Group name conflicts,
Ungroup/member-change missing Routers and adopted native occurrences no longer observed, inspect
current complete managed inventory, unchanged managed removal plans and complete public native
preservation status. Acknowledge only those exact fresh facts; original completion remains
unknown. New mutations still require their own complete domain plan. Public observation cannot
reconstruct a lost historical native result. Reload/Disable retains the existing truthful loss
of ephemeral records without replay or inferred success.

The donor's [library/exposure authority](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-046-explicit-skillager-library-and-exposure-authority.md)
retains exact source/target binding and preservation, off-paint execution, independent reading,
and no force or automatic retry. Its built-in owner and private-state grants are replaced by
the ordinary extension and public capability contract. The donor's [project curation decision](https://github.com/jarmak-personal/hvir/blob/05b41077ee90d4f8b332b823b21a11fbc0181391/docs/adr/ADR-049-project-skill-explorer-and-curation.md)
retains complete desired membership, explicit departures/replacements, preserved originals,
shared-tag protection, curated-tag retention and truthful recovery. Its built-in integration
code is not ported. ADR-059 continues to own all unaffected everyday management and lifecycle
rules; Skillager's supported public whole-plan contract supplies the advanced domain authority.

## Consequences

Advanced local choices share existing action, connector, review and uncertainty lifetimes.
The fixed package and transport capacities may refuse a large complete selection without
hiding its effects. Repair can require ordinary file tools and the public CLI before new
safe observations become available. Domain verification and user decisions remain distinct.

## Rejected alternatives

- Adding one exported action per CLI verb exceeds the bounded semantic action contract.
- Chaining individual copy mutations discards complete Router/tag and preservation authority.
- Reading private Skillager metadata or recomputing tree hashes introduces competing policy.
- Removing retained recovery objects or replaying unknown mutations risks user-owned bytes.
