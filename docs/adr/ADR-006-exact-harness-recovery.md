# ADR-006: Exact harness recovery instead of a PTY daemon

> [ADR-020](ADR-020-two-explicit-recovery-skips-forget-record.md) supersedes only the
> retention-until-explicit-close rule in this record. The remaining decisions still apply.

## Context

The durable asset in an agent terminal is the harness conversation, not the PTY process.
Claude Code and Codex persist conversations themselves, while keeping arbitrary PTYs alive
across application restarts would require a separate daemon and lifecycle protocol.

## Decision

Recover harness conversations through each harness's exact resume mechanism, never
through ambient “latest” state. All PTY creation goes through one main-owned PTY
supervisor. Harness-specific launch flags, resume composition, session discovery, title
normalization, and observers live behind the harness provider seam.

A provider either preassigns the session ID or discovers exactly one persisted record in
a bounded, fail-closed window qualified by the launch's working directory, time, provider
metadata, and matching record identity. Discovery may retry after later user input when a
harness creates its record lazily, but it never parses terminal text or delays unrelated
PTY creation. Missing or ambiguous identity leaves recovery visibly unavailable.

The PTY supervisor may own provider-structured context-pressure observation for the exact
session. Trustworthy used/window values render a neutral/amber/red meter at below 40%,
40–69%, and 70% or above. A trustworthy count without an authoritative window is shown as
a neutral count; missing trustworthy data is unknown. Screen scraping and model lookup
tables are not data sources.

A local recovery registry records terminal ID, provider/profile launch identity, exact
harness session ID when known, host-qualified project/workspace/cwd, title, rail order,
and presentation state. It stores no PTY output, prompt, credential, or transcript body.
Explicit terminal close forgets the record; ordinary navigation, renderer reload, host
disconnect, and app restart retain it. Restore is prompted and selected by default unless
the user explicitly enables automatic restore. Plain shells and provisional harness
records recreate a fresh process without claiming process continuity. Main authorizes
every resume against the exact stored terminal, provider, session, root, cwd, profile, and
launch revision.

## Consequences

Conversation recovery works for local and SSH projects without a resident hvir service.
It does not preserve scrollback, arbitrary shell process state, or mid-turn work across a
broken PTY. Provider persistence formats are version-sensitive but contained behind the
provider. A future daemon remains possible by replacing the PTY supervisor implementation
without changing the renderer contract.

## Rejected alternatives

- A PTY daemon for the normal restart case; the complexity is deferred, not foreclosed.
- tmux control mode, which would make hvir render and manage tmux's terminal model.
- Global `--last`, title/cwd guesses, terminal-screen parsing, or choosing among ambiguous
  persisted sessions.
- Auto-restoring processes by default or implying a recreated plain shell survived.
- Storing recovery state on each remote host or persisting terminal output and transcripts.
