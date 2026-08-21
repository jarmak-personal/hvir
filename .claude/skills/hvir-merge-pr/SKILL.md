---
name: hvir-merge-pr
description: Merge and reconcile one explicitly authorized ordinary hvir issue pull request to main. Use after hvir-implement-issue returns an exact verified candidate and the maintainer wants that one pull request accepted. Epic-child and cumulative epic integration remain owned by hvir-implement-epic.
---

# Merge an ordinary hvir pull request

Accept one exact ordinary delivery candidate without extending implementation, review, or epic
coordination authority. Require the maintainer to invoke `$hvir-merge-pr <pull-request-number>`;
the pull request number is the only accepted maintainer input. If it is absent, stop and request
it. Do not request or accept a separately supplied issue number or candidate SHA. The repository
operation resolves the one native closing issue and snapshots the pull request's full head SHA,
then validates both before mutation. Do not infer authorization from an implementation handoff or
an open pull request.

Read `AGENTS.md`, `CONTRIBUTING.md`,
[`docs/project-management.md`](../../../docs/project-management.md), and
[`ADR-037`](../../../docs/adr/ADR-037-promote-tested-pull-request-candidates.md) before acting.
Do not invoke `hvir-review-code`; independent review remains separately authorized. Merge
acceptance is maintainer work, not a new agent-work phase, so this skill opens no measurement run
and invents no review record or usage.

## Use the ordinary merge owner

Supply credentials only through the environment documented in `docs/project-management.md`.
Plan the complete exact-candidate operation, inspect its structured result, then apply a freshly
recomputed plan:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run issue:merge -- --pull-request <pr> --json

HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run issue:merge -- --pull-request <pr> --apply --json
```

The repository operation owns ordinary-delivery validation, the exact-head guarded GitHub merge,
post-merge retry, native closure confirmation, canonical Project convergence, append-only
first-pass reconciliation, and the named measurement projection. Treat every reported diagnostic
as a stop or recovery condition; do not recreate its policy with ad hoc `gh`, comment, or Project
mutations.

If the report identifies a native parent, a root epic, an epic base, an incomplete or ambiguous
relationship, or any other non-ordinary delivery, stop and direct the maintainer to
`hvir-implement-epic`. Never merge an epic child or cumulative epic pull request from this skill.

## Recover after a partial result

A successful GitHub merge is never rolled back by a later closure, Project, ledger, or projection
failure. Preserve the authorized pull-request number and the resolved issue/candidate identity in
the report. Diagnose only the named failure, then rerun the same PR-number-only dry-run/apply
sequence. The repository operation rereads current GitHub and ledger state, skips a proven
existing merge, and uses append idempotency and supersession rather than editing or duplicating
measurement history.

Do not change the branch, candidate, pull-request body, issue relationship, implementation
records, or Project fields by hand to make a blocked result pass. A changed candidate returns to
`hvir-implement-issue`; a merge conflict, failed or pending required check, draft, base mismatch,
head mismatch, relationship mismatch, or unresolved review state remains blocked for explicit
maintainer action.

## Hand off the accepted result

Return a compact maintainer handoff containing:

- issue, pull request, base, head branch, exact candidate SHA, and recorded merge commit SHA;
- required-check outcomes for that exact head and whether this run merged or recovered;
- native issue closure and canonical Project Status;
- active first-pass outcome, append result, measurement availability, and projection result;
- confirmation that no review usage was invented and no epic integration was performed; and
- any post-merge reconciliation failure plus the exact PR-number retry invocation.
