---
name: hvir-merge-pr
description: Accept and reconcile one explicitly authorized final hvir pull-request candidate. Use after a verified ordinary or cumulative epic handoff when the maintainer wants that exact candidate merged; ordinary mutation remains repository-owned and cumulative epic acceptance transfers to hvir-implement-epic.
---

# Accept a final hvir pull request

Treat an explicit `$hvir-merge-pr` invocation as maintainer acceptance of one exact final
candidate without extending implementation or review authority. Resolve the pull-request number
before any repository operation:

- When the invocation includes one pull-request number, use that number.
- When it omits the number, reuse one only when the latest verified lifecycle handoff in the
  active interaction identifies exactly one pull request as its final candidate.
- If no such candidate exists, or the available handoff can identify more than one candidate,
  stop and ask the maintainer for one pull-request number.

Never search the repository, issue history, Project, branch list, or open pull requests to infer a
candidate. Do not request or accept a separately supplied issue number or candidate SHA. A handoff
supplies only the accepted pull-request number; repository-owned policy must freshly resolve the
issue, exact current head, relationship, and delivery kind before mutation. A missing or
ambiguous handoff does not authorize a best guess.

Read `AGENTS.md`, `CONTRIBUTING.md`,
[`docs/project-management.md`](../../../docs/project-management.md), and
[`ADR-037`](../../../docs/adr/ADR-037-promote-tested-pull-request-candidates.md) before acting.
Do not invoke `hvir-review-code`; independent review remains separately authorized. Merge
acceptance is maintainer work, not a new agent-work phase, so this skill opens no measurement run
and invents no review record or usage.

## Classify before mutation

Supply credentials only through the environment documented in `docs/project-management.md`.
For every resolved number, first plan the exact-candidate ordinary operation and inspect its
structured result:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run issue:merge -- --pull-request <pr> --json
```

This dry run is the repository-owned read-only classifier. It resolves the one native closing
issue and snapshots the pull request's full current head SHA. Do not recreate its relationship,
head, check, or merge policy with ad hoc `gh`, comments, branch searches, or Project mutations.

Continue by exactly one classified path:

- An ordinary pull request with a clean `would-merge` or `would-reconcile` report stays with this
  skill. Apply a freshly recomputed plan:

  ```sh
  HVIR_REPO_TOKEN="$(gh auth token)" \
  HVIR_PROJECT_TOKEN="$(gh auth token)" \
  npm run issue:merge -- --pull-request <pr> --apply --json
  ```
- A pull request may transfer to `hvir-implement-epic` only when the report resolves one issue and
  exact candidate, targets `main`, has no diagnostic except `issue-not-ordinary`, and the epic
  skill's own authority checks freshly qualify it as the cumulative pull request for that root
  epic. Pass the resolved pull-request number and candidate identity internally; do not ask the
  maintainer to invoke another skill.
- Any epic-child, missing or ambiguous relationship, non-`main` base, changed or invalid head,
  failed or pending check, unresolved review, or other non-ordinary classification remains
  blocked. Never route merely because `issue-not-ordinary` appears alongside another diagnostic.

The repository operation owns ordinary-delivery validation, the exact-head guarded GitHub merge,
post-merge retry, native closure confirmation, canonical Project convergence, append-only
first-pass reconciliation, and the named measurement projection. Treat every reported diagnostic
as a stop or recovery condition unless the sole `issue-not-ordinary` diagnostic takes the
explicit cumulative-epic transfer above. Never merge an epic child from this skill or transfer
an ambiguous non-ordinary pull request.

Ordinary acceptance is not a new agent-work phase: this skill opens no measurement run and
invents no review record or usage. A cumulative transfer is different only in ownership: the
receiving `hvir-implement-epic` workflow opens and records its one resumed cleanup run. This skill
does not record a second merge phase.

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
- the selected ordinary or cumulative-epic route, including any internal transfer;
- confirmation that no review usage or merge-phase measurement was invented; and
- any post-merge reconciliation failure plus the exact PR-number retry invocation.
