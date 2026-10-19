# ADR-080: Bounded sync no-effect summaries

> Lifecycle: Active
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Individual identity rows for every synchronization outcome; only the exact proven no-effect categories may be summarized.

## Context

Large discovered inventories can contain many sources that approved-source sync leaves
unchanged. Counting those rows against the bounded detailed action report prevents useful
work even when every consequential outcome fits. Compact presentation must not hide effects,
repair locations, coverage gaps, or drift between preview and actual execution.

## Decision

Validate the complete bounded public observation, unique source identities, library binding,
counts, coverage and supported status/exit relationships before projecting a report.
Summarize only exact skipped/not-started/source-not-approved/repair-none outcomes and exact
unchanged/accepted/null-reason/repair-none outcomes without recovery information. Label the
former “not approved for sync”; this category does not establish that sources are unreviewed
rather than blocked. The corresponding exact public preflight categories may be projected
for capacity admission. All other outcomes and every repair/recovery path remain detailed.
Original total counts and coverage, detailed totals and summary counts reconcile visibly.

Retain the existing 256 KiB complete metadata bound, 32 detailed-row bound, 5 KiB projected
detail and 512-byte coverage admission, and 6 KiB action-result bound. The complete validated
public preflight remains human-inspectable and digest-bound, including all identities and
lineage. Public sync supplies no selection/token guarantee and re-discovers during apply.
Independently validate and classify every actual response. If consequential actual outcomes
exceed the report bounds, retain the exact operation and complete admitted raw report through
existing pages, with uncertainty and no automatic retry.

Safe-repeat reconciliation uses the same bounded projection plus a digest of the complete
fresh public observation. Acknowledgment re-observes that digest; changed summarized identities
or lineage invalidate the prior observation. Complete supported coverage remains mandatory,
and original completion remains unknown.

A supplied local workspace uses its separately approved project connector and discovery
context. Untargeted sync uses the application library connector. SSH sync is refused before
execution. The package maps message-only definite domain refusals to the existing bounded
action-error channel. Refusals with target, reason, tracking or operation facts retain those
structured details; partial and uncertain results retain their operation identity and details.
Core remains unaware of Skillager outcome fields.

## Consequences

Large inert inventories remain usable without raising public limits. Consequential expansions
can still require explicit recovery through retained public evidence. No-effect summaries are
presentation facts rather than authority to exclude sources from a subsequent mutation.

## Rejected alternatives

- Raising limits or dropping rows weakens bounded and truthful reporting.
- Using approved-origin counts as source selection confuses origins with unique logical sources.
- Reusing preview exclusions for actual outcomes assumes a token guarantee the CLI does not offer.
- Treating partial or uncertain operations as ordinary action errors loses recovery facts.
