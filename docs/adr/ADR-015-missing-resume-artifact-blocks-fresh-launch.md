# ADR-015: Missing resume artifacts block implicit fresh launches

## Context

Exact harness recovery may determine that the provider-owned artifact for a retained
conversation is definitely absent or empty. A fresh launch in the retained terminal slot is
not an equivalent recovery outcome: it creates a different conversation while the user is
expecting the original one, and reusing the retained identity can make later recovery
ambiguous.

ADR-012 previously allowed a definitely absent or empty artifact to start fresh in the same
terminal slot. That fallback obscures the failed recovery attempt and conflicts with the
fail-closed, visibly unavailable recovery model in ADR-006.

## Decision

When a user or automatic recovery flow requests an exact resume and the provider reports its
qualified artifact missing, hvir does not spawn a PTY or compose a fresh harness launch. The
provider seam returns a typed missing-artifact decision, main translates it into a typed,
provider-independent resume-unavailable result, and the renderer keeps that state visible
without parsing error text.

The retained recovery record and exact harness identity remain unchanged. Recovery outcome is
separate from session identity status: a known retained identity does not imply that a process
resumed it. A later retry revalidates the provider artifact through `ProjectHost` for local and
SSH hosts alike.

Starting a genuinely fresh conversation remains an explicit user action. It allocates new
terminal and provider identities under its own lifecycle rather than replacing a retained
recovery identity implicitly. This record does not define post-spawn resume failure
classification or the fresh-start interaction and lifecycle.

This decision supersedes only ADR-012's rule that a definitely absent or empty artifact starts
fresh in the same terminal slot. ADR-012's provider, profile, recovery-authority, and extension
boundaries remain in force.

## Consequences

Users can distinguish an intended fresh launch from unavailable recovery, and renderer reloads
or application restarts cannot silently rewrite the retained conversation identity. Missing
artifacts do not allocate PTYs, renderer resource leases, telemetry observers, or replacement
recovery records.

A zero-turn conversation whose provider never wrote an artifact cannot resume automatically.
The user must retry after the artifact appears, close the retained terminal, or use the explicit
fresh-start workflow when available.

## Rejected alternatives

- Launching fresh with the retained harness identity, which can create a different conversation
  under an identity that still names the failed recovery attempt.
- Launching fresh with a new harness identity while silently replacing the retained record,
  which discards recovery authority without user consent.
- Encoding recovery failure in identity status, which conflates a known conversation identity
  with whether a process successfully resumed it.
- Persisting a terminal-screen or exception-message inference, which bypasses the provider seam
  and can become stale instead of revalidating the artifact.
