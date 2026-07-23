# ADR-019: Two explicit recovery skips forget the hvir record

## Context

ADR-006 retained terminal recovery metadata across restarts until the terminal was explicitly
closed. The recovery picker can therefore accumulate records that a user repeatedly declines,
even though hvir does not own the provider transcript and forgetting hvir's record does not
prevent later provider-native recovery.

A retention rule must distinguish an intentional recovery decision from interruption,
unavailability, or an incomplete probe. It must also remain host-qualified and must not expand
hvir's authority over provider-owned artifacts.

## Decision

The main-owned terminal session registry stores a consecutive recovery-skip count with each
host-qualified recovery record. A decision-ready record is skipped only when the user explicitly
chooses **Not now**, or leaves that eligible record unselected and chooses **Restore selected**.
The first consecutive skip retains the record and exposes that one more skip will forget it. The
second consecutive skip removes only that record from hvir's registry.

Restoring a record resets its count. Escape, dialog loss, renderer or application shutdown,
incomplete probing, and host, provider, profile, or executable unavailability make no skip
decision. Mixed selections apply reset and increment decisions independently in one main-owned
persistence operation.

Pruning never deletes, edits, or claims to clean up a provider-owned transcript, rollout, session
artifact, or remote-host file. Provider-native resume remains available under the provider's own
semantics.

This record supersedes only ADR-006's indefinite retention-until-explicit-close rule. ADR-006's
exact identity, provider ownership, PTY supervision, local registry, and host-qualified recovery
boundaries remain unchanged.

## Consequences

Stale recovery choices age out through a visible, repeated user action rather than a hidden
timeout. One accidental skip remains reversible, restored records require two later consecutive
skips, and local and SSH project records share the same policy without remote persistence.

The registry schema gains one bounded field and migrates older records with zero prior skips.
Recovery decisions that cannot be persisted remain visible for retry instead of advancing only
renderer state.

## Rejected alternatives

- Retaining every record until explicit terminal close, which leaves repeatedly declined records
  unbounded.
- Forgetting after one skip, which gives a single accidental action no recovery margin.
- Age- or count-based background cleanup, which hides the rule and can discard records without a
  user recovery decision.
- Deleting provider-owned artifacts, which exceeds hvir's recovery authority and would make
  provider-native recovery destructive.
- Keeping skip history in renderer storage, which would duplicate main-owned recovery state and
  break host-qualified persistence.
