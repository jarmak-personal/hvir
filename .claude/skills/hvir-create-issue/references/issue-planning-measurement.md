# Issue-planning measurement workflow

This reference owns only the parts of agent-work recording that are unique to issue creation.
Use these canonical authorities for the shared contract and operations instead of restating them:

- [`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md) defines phases,
  forecast factors, field vocabulary, availability, attribution, timing, routes, and content
  exclusions.
- [`docs/agent-work-usage-proof.md`](../../../../docs/agent-work-usage-proof.md) defines the exact
  supported-provider snapshot, private checkpoint, and delta procedure.
- The [shared agent-work recording procedure](../../hvir-implement-issue/references/agent-work-recording.md)
  defines record construction, append, checkpoint release, issue projection, parent Rollup
  reconciliation, credentials, normalized reports, and retry behavior.
- [Agent-work measurement ledger](../../../../docs/project-management.md#agent-work-measurement-ledger),
  [Agent-work Project projections](../../../../docs/project-management.md#agent-work-project-projections),
  and [Agent-work epic Rollups](../../../../docs/project-management.md#agent-work-epic-rollups)
  document the repository commands and canonical Project field tables.

Measurement is optional evidence. Missing or incomplete evidence does not cancel approved issue
planning or publication.

## Start the authorized planning run

The first maintainer approval is the initial planning run's start boundary. Before product
research, create fresh run and idempotency keys under the canonical ledger rules and retain them
in task-specific private variables. Do not reuse keys from prior brainstorming or another run.

Open the repository-owned checkpoint with the fresh run key before research. GitHub has not yet
assigned the issue number, so use the explicit private `pending` locator. It is valid only for
`issue-planning`; the returned real issue number later belongs to the ledger record and Project
operations, not this pre-publication checkpoint identity:

```sh
npm run --silent agent-work:checkpoint -- start \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
```

Follow the shared recording procedure's identity, launch-directory, content-exclusion, active
clock, and unavailable-evidence rules. Apply them to the pending locator above. A repeated start
with the same pending locator, provider, identity, and run key is `unchanged` and preserves the
first baseline.

## Draft, review, and preview

Product-fit research, brainstorming, drafting, revision, and any authorized issue review belong
inside the planning phase. Add exactly one `## Initial forecast` section to the issue body. Use
the canonical four-factor rubric, its derived difficulty, Risk, Estimate confidence, and a
concise rationale. Use the exact vocabulary in the canonical measurement and Project tables.

Handle reviewer attribution before final preview:

- Append a distinct reviewer planning record only when the review ran under a separately
  qualified session identity and its provider observation interval is proven disjoint from the
  drafting interval. Give that run fresh keys and its own pending planning checkpoint.
- If review ran inline, used the drafting session, overlapped the drafting interval, or has no
  proof of disjoint usage, do not create a second counter-bearing record. Keep the drafting
  observation truthful for its whole session and report reviewer attribution coverage as partial
  or unavailable.
- If a separately qualified, disjoint reviewer run yields partial or unavailable telemetry,
  preserve that status in its own record under the canonical contract.

This classification only observes review behavior that the existing workflow authorized. It
does not invoke, repeat, or change `hvir-review-issue` policy.

Preview all of these facts together:

- the exact issue title, body, and labels;
- the exact forecast-derived `Agent difficulty`, `Risk`, and `Estimate confidence` values;
- the intended `Initial model`, `Reasoning effort`, `Model route`, `Planning tokens`, and
  `Lifecycle tokens`, marked pending, partial, or unavailable until the final records exist; and
- the assumptions, open questions, and reviewer attribution coverage.

Stop after the preview and wait for separate publication approval. If the checkpoint is open,
pause it immediately before that wait. Resume it only when the authorized workflow continues. If
any title, body, or label changes, resume before revision, preview the new exact draft, pause
again, and require publication approval for that changed preview. Repeated pause or resume
operations are `unchanged`. Use the same pending locator, provider, and run key as start:

```sh
npm run --silent agent-work:checkpoint -- pause \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
npm run --silent agent-work:checkpoint -- resume \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
```

## Finalize and publish once

After publication approval and resume, finish the exact pending checkpoint. This is the drafting
run's finalization observation. A failure leaves the checkpoint available for an exact finish
retry. A successful finish retains its content-free observation; a repeated finish returns that
same observation without another provider read. Retain the result privately and perform no more
research, drafting, revision, or review before the fixed issue-creation operation:

```sh
planning_observation="$(npm run --silent agent-work:checkpoint -- finish \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key")"
```

Create the exact approved issue once. Save its returned issue number and URL immediately as
`planning_issue_number` and `planning_issue_url`. They are the post-publication recovery
checkpoint for every later operation. A conclusively failed create may retry only the unchanged
approved request. An ambiguous create result stops for read-only resolution and never authorizes
another create request.

After creation, adapt the shared agent-work recording procedure in one deliberate way: construct
the record with `planning_issue_number`, while every checkpoint finish, release, or recovery
operation continues to use the original `pending` locator. Use the fixed `issue-planning` phase,
that run's private keys, and its finished observation or canonical unavailable reason. Do not
interpolate issue text, shell-source JSON, use `eval`, or print credentials.

Then follow the shared procedure for each intended drafting or qualified-disjoint reviewer
record: dry-run and apply the append, confirm the active ledger, release the finalized pending
checkpoint only after append confirmation, project the issue, and reconcile its exact native
parent when one exists. Use the canonical documentation for Project membership and field
semantics. A failure after creation resumes from `planning_issue_number` and
`planning_issue_url`; it never recreates the issue or appends a different retry record.

The handoff names `planning_issue_url` plus the start/final observation, creation, each intended
append, Project membership, projection, applicable parent Rollup, and reviewer-coverage outcome.
Expose only normalized reports and content-free evidence.

If the workflow is abandoned while its checkpoint is still open, invoke `abandon` with the same
pending arguments used for start. Never abandon a finalized checkpoint; retain it for append
recovery and release it only after append confirmation:

```sh
npm run --silent agent-work:checkpoint -- abandon \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
```

## Measure a pre-implementation forecast revision

A material forecast revision is a new planning run. Its start boundary is the maintainer's
explicit authorization to revise the existing issue. Create fresh keys and open a fresh
checkpoint at that boundary. Because the issue now exists, use its real positive issue number
rather than `pending`. Never reuse the original drafting baseline, observation, or keys.

Confirm that implementation has not started. Preserve the original `## Initial forecast` and
append one `## Pre-implementation forecast revision` that references it and uses the canonical
factor fields, headlines, and rationale. Preview the exact updated body and intended Project
values. Obtain separate approval for the issue-body edit.

Pause the checkpoint for that approval and resume when work continues. Finish immediately before
the approved issue-body edit, with no further revision work between those operations. Once the
edit succeeds, treat the updated body as the recovery checkpoint and follow the shared recording
procedure for append, release, projection, and applicable parent reconciliation. A later failure
resumes after the proven body edit; it does not repeat the edit, append a second record, or reuse
the original run.

If implementation has started, return the scope change for issue alignment without adding or
replacing a forecast.

## Recover at planning checkpoints

Use these issue-creation checkpoints before entering the shared post-creation procedure:

| Proven checkpoint | Safe continuation |
| --- | --- |
| Publication approval is absent | Keep the open checkpoint paused. Do not finish or publish. Abandon only if the planning workflow itself is abandoned. |
| Creation conclusively failed after finish | Retain the finalized checkpoint. Retry only the unchanged approved create request, or preview a changed draft under a new run. |
| Creation is ambiguous after finish | Retain the finalized checkpoint and stop for read-only resolution. Do not issue another create request. |
| `planning_issue_url` exists | Never recreate the issue. Continue the shared recording procedure against `planning_issue_number`; retry finish only to recover its identical retained observation. |
| Approved forecast body edit succeeded | Never repeat that edit for the run. Continue the shared recording procedure. |

## Deterministic fixtures

Use these fixtures to check the planning-specific policy without external writes:

| Fixture | Inputs | Required state and effects |
| --- | --- | --- |
| Authorization boundary | A finding exists without issue-work authorization. | No checkpoint, research, draft, review, or publication. |
| Draft approval only | Issue work is authorized and previewed; publication approval is absent. | One pending checkpoint may be open and paused. No finish or external write. |
| Changed preview | Title, body, or labels change after preview. | Re-preview the exact changed draft; prior publication approval is insufficient. |
| Disjoint reviewer session | Review has a separately qualified identity and a provider interval disjoint from drafting. | Prepare its own planning record without overlapping the drafting record. |
| Inline or overlapping reviewer | Review shares or may overlap the drafting session. | Prepare no second counter-bearing reviewer record; report attribution partial or unavailable. |
| Creation rejected | The fixed create request conclusively fails after finish. | Retain the finalized checkpoint and retry only the unchanged approved draft. |
| Creation uncertain | The create request has no conclusive result after finish. | Retain the finalized checkpoint, stop for read-only resolution, and issue no second create request. |
| Created issue retained | Creation returned an issue URL and a later operation did not complete. | Retain that issue and continue through the shared recording procedure without another create request. |
| Material scope revision | The maintainer authorizes revision before implementation, then separately approves the edit. | Use fresh observations around revision work and the body edit; preserve the initial forecast. |
| Late scope revision | Implementation has started. | Do not append or replace a forecast; return for issue alignment. |

These fixtures prove only the contributor-workflow sequencing owned here. Provider, ledger,
Project, append, projection, and Rollup behavior remain covered at their canonical owning seams.
