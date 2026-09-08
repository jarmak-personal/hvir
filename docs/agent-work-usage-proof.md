# Contributor usage observations

Bundled providers own exact artifact location, session qualification, record selection,
deduplication, and counter normalization. Contributor capture receives only a normalized snapshot;
private identity and paths never enter receipts or status output.

Use [session token capture](project-management.md#session-token-capture) for an exact current
supported Codex or Claude Code session. No separate phase-delta proof or checkpoint command remains.

Contributor reads have a 30-second cancellation deadline, bounded individual records (256 KiB),
and bounded Claude deduplication memory (2,048 records). They stream the complete artifact rather
than reject it merely for crossing the live observer's 8 MiB I/O bound. Incomplete reads, unsafe
identity, missing additive counters, or exhausted memory bounds never produce a total.

A later Codex cumulative record can restore counters invalidated by an oversized earlier record.
Claude additive records cannot be reconstructed from a tail. Application telemetry retains its
existing byte bounds and live behavior. Tests use explicit host-qualified fixtures, not ambient
user sessions.

One real observation proves only one provider session, not complete issue coverage, cross-machine
recovery, or a promised error percentage.
