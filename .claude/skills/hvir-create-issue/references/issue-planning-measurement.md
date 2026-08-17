# Issue-planning measurement workflow

This reference owns `hvir-create-issue` measurement sequencing. Use these canonical authorities
instead of restating their policy:

- [`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md) defines phases,
  forecast factors, availability, attribution, timing, routes, and content exclusions.
- [`docs/agent-work-usage-proof.md`](../../../../docs/agent-work-usage-proof.md) defines the exact
  supported-provider snapshot, private checkpoint, and delta procedure.
- [Agent-work measurement ledger](../../../../docs/project-management.md#agent-work-measurement-ledger)
  and [Agent-work Project projections](../../../../docs/project-management.md#agent-work-project-projections)
  define record construction, credentials, dry-run/apply operations, reports, and recovery.

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

For Codex, the command qualifies the exact current `CODEX_THREAD_ID` directly. For Claude Code,
provide the explicitly preassigned current session identity through `HVIR_USAGE_SESSION_ID`
without printing it. Set `HVIR_USAGE_CWD` only when the command does not run from the exact harness
launch directory. The checkpoint privately retains those inputs, its provider artifact context,
the content-free baseline, and a monotonic active clock across stateless tool shells and
compaction. Epoch and monotonic anchors must agree across those processes; otherwise the final
observation omits active time. Its output contains none of the private locator, run key, session,
path, or artifact facts.

A repeated start with the same pending locator, provider, identity, and run key is `unchanged` and
preserves the first baseline. A missing exact identity or unavailable start snapshot retains the
fixed reason and does not block issue planning.

## Draft, review, and preview

Product-fit research, brainstorming, drafting, revision, and any authorized issue review belong
inside the planning phase. Add exactly one `## Initial forecast` section to the issue body. Use
the canonical four-factor rubric, its derived difficulty, Risk, Estimate confidence, and a
concise rationale. Keep the seven projected rubric lines in the exact field spelling documented
by the Project projection contract.

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
  `Own lifecycle tokens`, marked pending, partial, or unavailable until the final records exist;
  and
- the assumptions, open questions, and reviewer attribution coverage.

If the checkpoint is open, pause it immediately before waiting for the separate publication
approval. Resume it when the authorized workflow continues. If any title, body, or label changes,
resume before revision, preview the new exact draft, pause again for its approval, and resume once
that approval arrives. Repeated pause or resume operations are unchanged. Use the same pending
locator, provider, and run key as start:

```sh
npm run --silent agent-work:checkpoint -- pause \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
npm run --silent agent-work:checkpoint -- resume \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
```

## Finalize, publish once, append, and project

After publication approval and resume, finish the exact pending checkpoint. This is the drafting
run's finalization observation. An operational failure leaves the checkpoint open for an exact
finish retry. A successful finish atomically retains its content-free observation; a repeated
finish returns that identical observation without another provider read. Retain the result
privately as `planning_observation`, and perform no more research, drafting, revision, or review
before the fixed issue-creation operation:

```sh
planning_observation="$(npm run --silent agent-work:checkpoint -- finish \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key")"
```

If start or finish is unavailable, retain the canonical reason instead of inventing evidence.

Create the issue once. Save the returned issue number and URL immediately as
`planning_issue_number` and `planning_issue_url`. They are the post-publication recovery
checkpoint for every later operation. An ambiguous create result stops for read-only resolution;
it never authorizes another create request.

Construct each `planning_record` with a JSON serializer from only these sources:

- `planning_issue_number` and the fixed `issue-planning` phase;
- that run's private keys;
- the provider-neutral finished observation or canonical unavailable reason; and
- any truthful timing or route facts admitted by the canonical schema.

Do not interpolate issue text, shell-source the JSON, use `eval`, or print credentials. Serialize
the record once into the task-specific `planning_record` variable and pass it only through the
documented `HVIR_AGENT_WORK_RECORD` environment input.

Immediately before repository and Project operations, source scoped credentials without printing
them:

```sh
planning_repo_token="$(gh auth token)"
planning_project_token="$planning_repo_token"
test -n "$planning_repo_token" && test -n "$planning_project_token"
```

Use those variables as `HVIR_REPO_TOKEN` and `HVIR_PROJECT_TOKEN` for the canonical operations.
Dry-run and apply each intended drafting or qualified-disjoint reviewer append. Continue only
after each intended record is confirmed active under the canonical report. Unset the private
observation after record construction. Only after an append is confirmed as `appended` or the
identical `duplicate`, release that run's finalized checkpoint with its same locator, provider,
and run key:

```sh
npm run --silent agent-work:checkpoint -- release \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
```

Never release after only a dry run, a failed or uncertain append, or before a recoverable finish
result has been converted into its record. Release is not cleanup for an open checkpoint.

Read canonical Project membership before projection. If the issue does not yet have one active
canonical Project item, keep the issue and active ledger record, report projection as incomplete,
and retry projection after membership exists. When membership is active, dry-run and apply the
canonical projection from the current issue and active ledger.

If projection fails or partly applies after append, retry only the canonical Project projection
from the current issue and active ledger. Do not append another record and do not recreate the
issue.

After projection has a reportable outcome, dry-run and apply the issue's separate Rollup
reconciliation. This clears a stale Rollup from an ordinary issue or epic child. If publication
has established one exact native direct parent, repeat only the Rollup operation for that parent
so the child's planning usage enters the parent's current direct-child Rollup. Do not guess a
parent, traverse descendants, or mutate a child while reconciling its parent.

Output only the commands' normalized reports and the final handoff. The handoff names
`planning_issue_url` plus the start/final observation, creation, each intended append, Project
membership, projection, applicable Rollup, and reviewer-coverage outcome.

If the workflow is abandoned while its checkpoint is still open, invoke `abandon` with the same
arguments used for start. Never abandon a finalized checkpoint; retain it for append recovery and
release it only after append confirmation. After the workflow finishes its handoff or abandons
the open checkpoint, unset only the retained task-specific variables:

```sh
# Only when abandoning a still-open workflow:
npm run --silent agent-work:checkpoint -- abandon \
  --issue pending --phase issue-planning --provider "$planning_provider" \
  --run-key "$planning_run_key"
unset planning_record planning_observation planning_unavailable_reason
unset planning_repo_token planning_project_token
```

## Measure a pre-implementation forecast revision

A material forecast revision is a new planning run. Its start boundary is the maintainer's
explicit authorization to revise the existing issue. Create fresh keys and open a fresh checkpoint
at that boundary. Because the issue now exists, use its real positive issue number rather than
`pending`. Never reuse the original drafting baseline, finished observation, or keys.

Confirm that implementation has not started. Preserve the original `## Initial forecast` and
append one `## Pre-implementation forecast revision` that references it and uses the same
canonical factor fields, headlines, and rationale. Preview the exact updated body and intended
Project values. Obtain separate approval for the issue-body edit.

Pause the open checkpoint for the separate body-edit approval and resume when work continues. The
revision run's retry-safe finish occurs immediately before that approved issue-body edit. Perform
no additional revision work between finish and the edit. Once the edit succeeds, treat the updated
issue body as the recovery checkpoint, construct the revision record from its finished
observation, append it, release only after append confirmation, and re-project. A later failure
resumes after the proven body edit; it does not repeat the edit, append a second record, or reuse
the original run.

If implementation has started, return the scope change for issue alignment without adding or
replacing a forecast.

## Recover at workflow checkpoints

Use the canonical command reports for append and projection retries. These workflow checkpoints
decide which external effect is safe to attempt:

| Proven checkpoint | Safe continuation |
| --- | --- |
| Publication approval is absent | Keep the open checkpoint paused. Do not finish, create, append, release, or project. Abandon only if the open workflow itself is abandoned. |
| Creation conclusively failed after finish | Retain the finalized checkpoint. Retry only the unchanged approved create request, or preview a changed draft under a new run. Do not abandon or release it. |
| Creation is ambiguous after finish | Retain the finalized checkpoint and stop for read-only resolution. Do not issue another create request, abandon, or release. |
| `planning_issue_url` exists | Never recreate the issue. Resume the same-record append against that issue; retry finish only to recover its identical retained observation. |
| Intended append is unconfirmed | Retain the finalized checkpoint and retry the same append with the same record and idempotency key. |
| Intended append is active or an identical duplicate | Release that run's finalized checkpoint once, then continue to Project projection. |
| All intended records are active but Project membership is absent | Retain the ledger and retry projection only after membership becomes active. |
| Projection partly applied or failed | Retry only the canonical projection operation. Do not append again. |
| Approved forecast body edit succeeded | Never repeat that edit for the run. Resume its append or projection. |

## Deterministic fixtures

Use these fixtures to check the workflow without external writes:

| Fixture | Inputs | Required state and effects |
| --- | --- | --- |
| Authorization boundary | A finding exists without issue-work authorization. | No checkpoint, research, draft, review, publication, append, or projection. |
| Draft approval only | Issue work is authorized and previewed; publication approval is absent. | One pending checkpoint may be open and paused. No finish, external write, or release. |
| Changed preview | Title, body, or labels change after preview. | Re-preview the exact changed draft; prior publication approval is insufficient. |
| Complete drafting run | A qualified pending checkpoint yields a complete observation and all external operations confirm. | One issue creation, one active drafting record, append-confirmed checkpoint release, exact planning projection, complete handoff. |
| Partial drafting delta | Qualified drafting observations yield only a canonical partial delta. | Publish after approval, append one partial drafting record, omit an exact planning total, and report partial coverage. |
| Drafting telemetry unavailable | Exact drafting identity or a supported observation is unavailable. | Publish after approval, append one unavailable drafting record, and report unavailable coverage without guessed usage. |
| Disjoint reviewer session | Review has a separately qualified identity and a provider interval disjoint from drafting. | Append its own record once; drafting and reviewer counters contribute without overlap. |
| Inline or overlapping reviewer | Review shares or may overlap the drafting session. | Append no second counter-bearing reviewer record; retain truthful drafting usage and report reviewer attribution partial or unavailable. |
| Creation rejected | The fixed create request conclusively fails after finish. | Retain the finalized checkpoint; retry only the unchanged approved draft and do not abandon or release. |
| Creation uncertain | The create request has no conclusive result after finish. | Retain the finalized checkpoint; stop for read-only resolution and issue no second create request. |
| Append incomplete | Creation returned an issue URL but an intended append is not confirmed active. | Retain the issue and finalized checkpoint; retry the same record and release only after append confirmation. |
| Projection before membership | The ledger is active but no active canonical Project item exists. | Preserve issue and ledger, report projection incomplete, and wait to retry projection after membership exists. |
| Project partial write | An active item exists and one named Project write fails after earlier writes. | Retry only canonical projection from current state; do not append again. |
| Material scope revision | The maintainer authorizes revision before implementation, then separately approves the edit. | Use fresh start/final observations around revision work and the body edit; preserve the initial forecast and re-project. |
| Late scope revision | Implementation has started. | Do not append or replace a forecast; return for issue alignment. |

These fixtures prove contributor-workflow sequencing only. Provider, ledger, and Project behavior
remain covered at their canonical owning seams.
