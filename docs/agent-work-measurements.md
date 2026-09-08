# Contributor token accounting

[ADR-041](adr/ADR-041-deterministic-contributor-status.md) replaces exact phase accounting with
approximate session-attributed totals. The [Project interface](project-management.md#contributor-status)
owns commands and deployment instructions.

One provider session belongs to one issue; a coordinator belongs to its epic. Capture observes
cumulative normalized tokens and records that contribution once. Repeated captures retain its
largest observed total. Direct-parent aggregation counts each contribution once, never adding
child totals to an already aggregated epic row.

Counters are observed, not fabricated. Attribution is approximate: a session may include discussion,
while unsupported or unrecorded sessions remain uncovered. Missing additive counters are not zero.
Fresh input, cache read, cache write, and output are disjoint after provider normalization;
reasoning detail is already inside output and is never added again.

Phases, forecasts, route histories, precision timing, first-pass outcomes, manual records, and
checkpoints are retired. Private session assignment is the only retained local accounting state.
Its random receipt key exposes no provider identity. Keep it on the originating machine for
recapture; loss or cross-machine copying loses automatic deduplication identity.

New totals are labeled observed session-attributed estimates since migration. Previous
`hvir-agent-work-measurement:v1` comments and Legacy fields remain historical, excluded from new
totals. Git preserves retired schema documentation; preserving history does not require old
writers and validators forever.

Reports contain no prompts, responses, reasoning text, transcripts, terminal content, source,
paths, credentials, provider session IDs, or artifact locators. Exact current identity stays
private and provider qualification stays behind bundled providers.

Project Status, required checks, review state, merge requests, and merge outcomes are separate
facts. Handoff is readiness. Maintainer invocation of `hvir-merge-pr` is approval; protected merge
is completion. A later report may state approval unknown; it never infers it from Done, issue
closure, green checks, review sentiment, or silence.
