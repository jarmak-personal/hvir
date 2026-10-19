# ADR-077: Combined project connection decision

> Lifecycle: Active
> Supersedes: [ADR-065](ADR-065-passive-extension-program-connection.md) | partial | Exclusion of an explicitly named workspace read scope from a trusted connection decision only.
> Supersedes: [ADR-070](ADR-070-explicit-local-workspace-program-connection.md) | partial | Active-selection-only setup pin for explicitly targeted application views and exclusion of an explicitly named workspace read scope from the connection decision only.

## Context

First connection can require both an installed program and selected-file reading in a chosen
project. Separate prompts repeat the user's setup intent. An application Library already has a
trusted explicit destination; requiring the project active elsewhere contradicts that choice.

## Decision

A current ordinary human Connect request may name one declared read-only workspace source
alongside its declared connector. Main derives the exact registered local workspace from the
admitted view. Prepare both identities before showing one compact trusted decision: the actual
host-qualified program, the selected-file project/worktree scope and exact location, and one
account-access explanation. Complete program configuration remains available in Details.
Reuse valid independent grants and display only missing scopes. Existing executable approval
never implies source permission. An application-library root unknown until a CLI reports it
retains its separate contextual read decision.

The connection owner composes the existing prepared source port and native approval owner;
each retains its own grant store, writer and revocation. Keep the source handle current through
both independent writes, cancel it in finally, and revalidate reused program bindings and resolved
targets after awaited consent. Publish truthful separate outcomes when only one write succeeds and separate current-readiness
facts when a completed write has since been revoked. Completed saves and admitted reuse remain
historical facts after cancellation. Combined readiness is true or false only when checked under
live, bounded authority; null means unconfirmed, including withdrawal before that check. No new
metadata work starts after authority ends, and cancellation does not imply rollback or revocation. Declining or cancelling settles the current attempt and
must not immediately replay setup as a second source prompt. Explicit later retry remains available.

For an ordinary human application view whose existing declaration permits trusted workspace
selection, pin that explicit registered destination and its owning registration/root independently
of ambient navigation. Project-bound views retain main's active-project/worktree pins. Main
derives this distinction from trusted declaration authority, never guest input. The existing raw
project observation permanently retires the finite request if its actual authority changes,
including registration transfer, root/host change, closure or unavailability. Trusted destination
replacement cancels existing guest requests. No guest selector or generalized target owner is added.

All unaffected foreground, selected-placement, chooser-return readiness, sixty-second deadline,
request/renderer/activation/writer lifetime, independent source authority and local-only setup
rules remain authoritative. ADR-071 and ADR-073 retain independent file authority; ADR-074 and
ADR-075 retain exact host bindings and session launcher trust. Installation does not acquire
workspace permission. No grant store, approval framework, polling, tool-domain policy or native
confinement claim is introduced.

## Consequences

First connection has one understandable decision while later current-state observations can
report partial readiness honestly. A Library destination stays stable across unrelated navigation;
project-bound setup still retires on a switch away and back.

## Rejected alternatives

- Combining grant stores or inferring reads from execution would widen authority.
- Speculating about a CLI's future library root would approve an undisplayed scope.
- Requiring ambient selection for Library would impose a hidden destination prerequisite.
- Atomic rollback claims and automatic fallback prompts would misrepresent independent writes
  and the user's declined attempt.
