# Issue-planning measurement workflow

This reference owns `hvir-create-issue` measurement sequencing. Use these canonical authorities
instead of restating their policy:

- [`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md) defines phases,
  forecast factors, availability, attribution, timing, routes, and content exclusions.
- [`docs/agent-work-usage-proof.md`](../../../../docs/agent-work-usage-proof.md) defines the exact
  supported-provider snapshot and delta procedure.
- [Agent-work measurement ledger](../../../../docs/project-management.md#agent-work-measurement-ledger)
  and [Agent-work Project projections](../../../../docs/project-management.md#agent-work-project-projections)
  define record construction, credentials, dry-run/apply operations, reports, and recovery.

Measurement is optional evidence. Missing or incomplete evidence does not cancel approved issue
planning or publication.

## Start the authorized planning run

The first maintainer approval is the initial planning run's start boundary. Before product
research, create fresh run and idempotency keys under the canonical ledger rules and retain them
in task-specific private variables. Do not reuse keys from prior brainstorming or another run.

Create the snapshot target from a checked task-specific temporary path:

```sh
planning_snapshot_file="$(mktemp -t hvir-issue-planning.XXXXXX)"
test -n "$planning_snapshot_file" && test -f "$planning_snapshot_file"
```

Source every provider input as the usage-proof document requires:

- `planning_provider` is the active bundled provider's exact `codex` or `claude-code` identifier.
- `HVIR_USAGE_SESSION_ID` is the current `CODEX_THREAD_ID` for Codex or the explicitly preassigned
  Claude Code session ID retained by its launcher. Do not discover a nearby session.
- `HVIR_USAGE_CWD` is the exact launch working directory retained for this harness run.
- `planning_snapshot_file` is the checked path created above, not a user-supplied path.

Run the canonical start-snapshot operation and direct only its provider-neutral output to
`planning_snapshot_file`. If any required source is absent or qualification fails, retain the
canonical unavailable reason and continue issue planning.

## Draft, review, and preview

Product-fit research, brainstorming, drafting, revision, and any authorized issue review belong
inside the planning phase. Add exactly one `## Initial forecast` section to the issue body. Use
the canonical four-factor rubric, its derived difficulty, Risk, Estimate confidence, and a
concise rationale. Keep the seven projected rubric lines in the exact field spelling documented
by the Project projection contract.

Handle reviewer attribution before final preview:

- Append a distinct reviewer planning record only when the review ran under a separately
  qualified session identity and its provider observation interval is proven disjoint from the
  drafting interval. Give that run fresh keys and its own start and final observations.
- If review ran inline, used the drafting session, overlapped the drafting interval, or has no
  proof of disjoint usage, do not create a second counter-bearing record. Keep the drafting delta
  truthful for its whole session and report reviewer attribution coverage as partial or
  unavailable.
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

Pause for the separate publication approval. If any title, body, or label changes, preview the
new exact draft and obtain approval again.

## Finalize, publish once, append, and project

After publication approval, run the canonical delta operation against
`planning_snapshot_file`. This is the drafting run's finalization observation. Perform no more
research, drafting, revision, or review before the fixed issue-creation operation.
Retain its provider-neutral output as the task-specific `planning_delta`; if collection is
unavailable, retain the canonical reason as `planning_unavailable_reason` instead.

Create the issue once. Save the returned issue number and URL immediately as
`planning_issue_number` and `planning_issue_url`. They are the post-publication recovery
checkpoint for every later operation. An ambiguous create result stops for read-only resolution;
it never authorizes another create request.

Construct each `planning_record` with a JSON serializer from only these sources:

- `planning_issue_number` and the fixed `issue-planning` phase;
- that run's private keys;
- the provider-neutral delta or canonical unavailable reason; and
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
after each intended record is confirmed active under the canonical report.

Read canonical Project membership before projection. If the issue does not yet have one active
canonical Project item, keep the issue and ledger checkpoint, report projection as incomplete,
and retry projection after membership exists. When membership is active, dry-run and apply the
canonical projection from the current issue and active ledger.

After projection has a reportable outcome, dry-run and apply the issue's separate Rollup
reconciliation. This clears a stale Rollup from an ordinary issue or epic child. If publication
has established one exact native direct parent, repeat only the Rollup operation for that parent
so the child's planning usage enters the parent's current direct-child Rollup. Do not guess a
parent, traverse descendants, or mutate a child while reconciling its parent.

Output only the commands' normalized reports and the final handoff. The handoff names
`planning_issue_url` plus the start/final observation, creation, each intended append, Project
membership, projection, applicable Rollup, and reviewer-coverage outcome.

After the workflow finishes its handoff or is abandoned, clean only the retained task-specific
state:

```sh
test -n "$planning_snapshot_file" && test -f "$planning_snapshot_file" && \
  rm -f -- "$planning_snapshot_file"
unset planning_record planning_delta planning_unavailable_reason
unset planning_repo_token planning_project_token planning_snapshot_file
```

## Measure a pre-implementation forecast revision

A material forecast revision is a new planning run. Its start boundary is the maintainer's
explicit authorization to revise the existing issue. Create fresh keys and a fresh task-specific
snapshot file at that boundary. Never reuse the original drafting baseline, final delta, or keys.

Confirm that implementation has not started. Preserve the original `## Initial forecast` and
append one `## Pre-implementation forecast revision` that references it and uses the same
canonical factor fields, headlines, and rationale. Preview the exact updated body and intended
Project values. Obtain separate approval for the issue-body edit.

The revision run's finalization observation occurs immediately before that approved issue-body
edit. Perform no additional revision work between the final observation and the edit. Once the
edit succeeds, treat the updated issue body as the recovery checkpoint, construct the revision's
record from its fresh observations, append it, and re-project. A later failure resumes after the
proven body edit; it does not repeat the edit or reuse the original run.

If implementation has started, return the scope change for issue alignment without adding or
replacing a forecast.

## Recover at workflow checkpoints

Use the canonical command reports for append and projection retries. These workflow checkpoints
decide which external effect is safe to attempt:

| Proven checkpoint | Safe continuation |
| --- | --- |
| Publication approval is absent | Do not finalize, create, append, or project. |
| Creation conclusively failed | Retry only the unchanged approved create request, or preview a changed draft again. |
| Creation is ambiguous | Stop for read-only resolution. Do not issue another create request. |
| `planning_issue_url` exists | Never recreate the issue. Resume the pending append or projection against that issue. |
| All intended records are active but Project membership is absent | Retain the ledger and retry projection only after membership becomes active. |
| Projection partly applied or failed | Retain the ledger and retry only the canonical projection operation. |
| Approved forecast body edit succeeded | Never repeat that edit for the run. Resume its append or projection. |

## Deterministic fixtures

Use these fixtures to check the workflow without external writes:

| Fixture | Inputs | Required state and effects |
| --- | --- | --- |
| Authorization boundary | A finding exists without issue-work authorization. | No baseline, research, draft, review, publication, append, or projection. |
| Draft approval only | Issue work is authorized and previewed; publication approval is absent. | The start observation may exist. No final observation or external write. |
| Changed preview | Title, body, or labels change after preview. | Re-preview the exact changed draft; prior publication approval is insufficient. |
| Complete drafting run | Qualified drafting observations yield a complete delta and all external operations confirm. | One issue checkpoint, one active drafting record, exact planning projection, complete handoff. |
| Partial drafting delta | Qualified drafting observations yield only a canonical partial delta. | Publish after approval, append one partial drafting record, omit an exact planning total, and report partial coverage. |
| Drafting telemetry unavailable | Exact drafting identity or a supported observation is unavailable. | Publish after approval, append one unavailable drafting record, and report unavailable coverage without guessed usage. |
| Disjoint reviewer session | Review has a separately qualified identity and a provider interval disjoint from drafting. | Append its own record once; drafting and reviewer counters contribute without overlap. |
| Inline or overlapping reviewer | Review shares or may overlap the drafting session. | Append no second counter-bearing reviewer record; retain truthful drafting usage and report reviewer attribution partial or unavailable. |
| Creation rejected | The fixed create request conclusively fails. | No issue checkpoint, append, or projection; retry only the unchanged approved draft. |
| Creation uncertain | The create request has no conclusive result. | Stop for read-only resolution; no second create request. |
| Append incomplete | Creation returned an issue URL but an intended append is not confirmed active. | Retain the issue and resume through the canonical append recovery for the same record. |
| Projection before membership | The ledger is active but no active canonical Project item exists. | Preserve issue and ledger, report projection incomplete, and wait to retry projection after membership exists. |
| Project partial write | An active item exists and one named Project write fails after earlier writes. | Retain the ledger and retry only canonical projection from current state. |
| Material scope revision | The maintainer authorizes revision before implementation, then separately approves the edit. | Use fresh start/final observations around revision work and the body edit; preserve the initial forecast and re-project. |
| Late scope revision | Implementation has started. | Do not append or replace a forecast; return for issue alignment. |

These fixtures prove contributor-workflow sequencing only. Provider, ledger, and Project behavior
remain covered at their canonical owning seams.
