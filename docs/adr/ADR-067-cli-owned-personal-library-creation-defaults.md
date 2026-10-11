# ADR-067: CLI-owned personal library creation defaults

> Lifecycle: Active
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Mandatory explicit initialization path and separate Git choice only.

## Context

Creating a personal library should not require knowledge of a filesystem location or a
history configuration. The supported public CLI owns its default location, Git creation
policy and preservation of an existing registration. Its default target is not publicly
known before initialization.

## Decision

The package's explicit Create personal library action uses a discriminated default or
custom location intent. Default invokes exactly `library init --json`. Advanced custom
intent supplies an absolute local host-qualified path and an explicit Git choice through
the existing public argv. Neither Enable, reading nor observation initializes a library.
Core acquires no Skillager workflow or filesystem authority.

Verify the complete supported initialization result against fresh public library status:
registered UUID, canonical root and actual history mode must agree. Default intent accepts
that verified registration without guessing its path or predicting its mode from an earlier
uninitialized observation. A concurrent registration or existing library retains its actual
identity and history. Custom intent retains explicit connection when the observed path or
mode differs from the request. Failed Git creation never falls back to no-Git.

An interrupted default initialization retains an unknown target in the existing ephemeral
operation owner. Block overlapping initialization while it remains unresolved, without
blocking unrelated operations. Public reconciliation may disclose the current registered
library while original completion remains unknown. An uninitialized status cannot prove
that partial files are absent at an undisclosed default target. Never invent that target,
inspect private HOME state, replay initialization or claim rollback from a cancellation.

## Consequences

The ordinary creation flow needs one explicit action; advanced path and no-Git controls
remain available. Public CLI registration remains the sole location and history authority.
Fresh default creation requires a genuinely disposable CLI home for physical acceptance;
task-owned catalog or XDG directories alone do not relocate that home.

## Rejected alternatives

- Guessing a HOME-relative root duplicates CLI policy and may target user files.
- Requiring path entry for every creation makes a supported default unnecessarily manual.
- Inferring new-library Git mode from a previous observation fails under registration races.
- Automatic retries or fallback after an unknown outcome can repeat partially committed work.
