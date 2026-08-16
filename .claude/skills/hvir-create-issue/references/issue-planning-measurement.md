# Issue-planning measurement workflow

This reference defines the `hvir-create-issue` measurement state machine. Follow it only after
the maintainer authorizes issue work. The canonical vocabulary and exclusions remain in
[`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md); repository
commands and wire schemas remain in
[`docs/project-management.md`](../../../../docs/project-management.md). This workflow does not
create a second ledger, Project writer, provider parser, or publication path.

Measurement is optional evidence. A missing snapshot, missing reviewer counter, or failed
measurement operation never cancels an approved issue publication. It does change the reported
coverage and the recovery step.

## Keep one private run record

Keep these facts in the agent run, not in the issue draft, repository, logs, or Project:

- whether issue work and publication have each received explicit approval;
- one content-free random run key and its derived idempotency key;
- the exact supported harness, qualified session identity, and launch working directory used only
  as private provider inputs;
- the exact temporary start-snapshot path;
- the provider-neutral final delta or fixed unavailable reason;
- the approved title, body, and labels;
- the created issue number and URL, once known;
- each append outcome and the Project projection outcome; and
- any separately authorized reviewer run, with its own keys and measurement state.

Generate the run key once from a fresh random 32-byte operation nonce. Derive the idempotency key
from a fixed namespace, the phase, the run key, and the append operation. Use only lowercase
SHA-256 hex. Do not derive either key from issue prose, prompts, responses, code, paths, provider
session identifiers, or other excluded content. Reuse the same keys on every retry of that run.

The issue number is unknown at the start and is not part of the run key. Add it to the record only
after publication succeeds.

## Follow the fixed boundaries

Use this order:

1. Receive explicit authorization for issue work.
2. Initialize the private run keys and attempt the start snapshot.
3. Perform product-fit research, brainstorming, drafting, any separately authorized issue review,
   and revision.
4. Add the initial forecast to the exact issue body.
5. Preview the exact title, body, labels, and intended Project values.
6. Pause and request publication approval. Approval wait is not active agent time.
7. After approval, finalize every planning measurement immediately before publication.
8. Create the issue once.
9. Save the returned issue number and URL as the publication checkpoint.
10. Append every intended planning record. A dry run precedes each apply.
11. After all records are active or confirmed duplicates, derive the Project projection. A dry
    run precedes apply.
12. Report the issue and every complete, partial, unavailable, failed, or uncertain operation.

Do not take the final snapshot before publication approval. Do not put research, drafting,
revision, or review between the final snapshot and issue creation. If the maintainer changes the
approved title, body, or labels, return to preview and obtain a new publication approval before
finalization.

## Capture provider-neutral evidence

Run provider collection from the repository root on the same local host as the harness. Use the
exact current Codex thread identity or an explicitly preassigned Claude Code session identity.
Never scan for a nearby or likely session. If the harness, exact identity, or supported artifact
is unavailable, retain the applicable fixed unavailable reason and continue planning.

Keep the start snapshot in one exact file created with `mktemp`. Supply the session identity and
working directory through `HVIR_USAGE_SESSION_ID` and `HVIR_USAGE_CWD` without printing them:

```sh
npm run proof:harness-usage -- snapshot <codex|claude-code> > "$planning_snapshot_file"
```

After publication approval, calculate the final delta from that same file:

```sh
npm run proof:harness-usage -- delta <codex|claude-code> < "$planning_snapshot_file"
```

Use only the provider-neutral JSON output. Never retain or expose the private session identity,
artifact identity, artifact path, launch path, environment, prompts, responses, transcript, or
raw provider records. Delete only the exact temporary file after finalization or abandonment.

Translate a complete delta to a complete ledger record. Preserve all additive counters,
reasoning detail, exact normalized total, available model/API timing, initial route, and observed
route changes. Treat the provider's observed effort as effective effort unless the harness also
truthfully exposes a distinct requested value. Mark a route change as an escalation only when
that intent was explicitly declared; never infer it from model names or effort labels.

Translate a partial delta to a partial record. Preserve observed counters and timing, list the
fixed missing facts, and omit `normalizedTokenTotal`. Translate an unavailable snapshot or delta
to an unavailable record with its fixed reason and no usage or timing claims. If exact run
identity was never available, use `run-identity-unproven`. Do not replace missing values with
zero. Omit active-wall or model/API time unless a truthful source supplies it with the contract's
semantics.

## Keep reviewer attribution separate

A separately authorized `hvir-review-issue` execution is another `issue-planning` run. Give it a
different random run key, derived idempotency key, start observation, finalization observation,
and ledger record. The drafting run does not absorb reviewer usage.

When the reviewer command exposes a qualified supported-provider identity, capture its truthful
delta. When it does not, prepare an unavailable reviewer record with the applicable fixed reason.
The overall planning measurement is partial because reviewer coverage is unavailable, even when
the drafting run is complete. Append the unavailable record after the issue exists so ledger and
Project consumers retain that missing coverage instead of presenting the drafting subtotal as an
exact planning total.

Do not invoke, repeat, or change issue-review policy for measurement. Collection observes a
review that the existing workflow already authorized.

## Append, then project

After issue creation, construct one schema-v1 record per intended run with the created issue
number and phase `issue-planning`. Pass the exact JSON only through `HVIR_AGENT_WORK_RECORD`.
Use the repository token environment documented for the command:

```sh
HVIR_REPO_TOKEN="$planning_repo_token" \
HVIR_AGENT_WORK_RECORD="$planning_record" \
npm run project:measure -- --issue <number> --append

HVIR_REPO_TOKEN="$planning_repo_token" \
HVIR_AGENT_WORK_RECORD="$planning_record" \
npm run project:measure -- --issue <number> --append --apply
```

Inspect the `would-append` dry-run report before apply. After apply, accept only `appended` or
`duplicate` as proof that the intended record is active. An uncertain append remains unresolved
even if the HTTP request may have succeeded. Retry the same operation with the same record and
key; the command re-reads the ledger and resolves a prior success as `duplicate`.

Do not project until every intended drafting and reviewer record is active or a confirmed
duplicate. Then use the separate projection operation with both repository and Project tokens:

```sh
HVIR_REPO_TOKEN="$planning_repo_token" \
HVIR_PROJECT_TOKEN="$planning_project_token" \
npm run project:measure -- --issue <number> --project

HVIR_REPO_TOKEN="$planning_repo_token" \
HVIR_PROJECT_TOKEN="$planning_project_token" \
npm run project:measure -- --issue <number> --project --apply
```

Inspect the named dry-run operations before apply. The command derives forecast, route, and usage
fields from the issue and active ledger. This planning workflow supplies no implementation,
first-pass, time-to-candidate, or epic-rollup facts. If Project automation has not yet created an
active canonical item, retain the issue and report projection as incomplete. Retry the projection
after membership exists; do not create another issue or append another record.

## Recover from partial writes

The created issue is the irreversible checkpoint. Recovery always resumes after the last proven
operation:

| Last proven state | Next action |
| --- | --- |
| No explicit issue-work approval | Do not capture, research, draft, review, or publish. |
| Draft previewed, publication not approved | Do not finalize, create, append, or project. Retain no claim that an issue exists. |
| Publication approved, creation conclusively failed | Retry creation only for the unchanged approved draft, or preview changes again. |
| Creation result ambiguous | Stop. Resolve the outcome with read-only evidence. Do not retry creation. |
| Issue URL returned | Store the number and URL. Never call issue creation again for this run. |
| Issue exists, append rejected or uncertain | Retry the same append against that issue with the same record and idempotency key. |
| Intended append is active or duplicate | Do not append it again under a new key. Continue with the next intended record or projection. |
| All intended records are active, projection failed or partly applied | Retry only `--project --apply`; it re-reads the active ledger and current fields. |
| Projection confirmed | Report the final issue URL and all operation outcomes. |

Never edit or delete an existing measurement comment. A factual correction uses a new key and
explicit supersession under the canonical ledger contract.

## Preserve forecast history

Before implementation starts, a material scope change may require one updated forecast. Confirm
the exact existing issue, native relationships, planning state, and absence of implementation
activity. Keep the original `Initial forecast` section byte-for-byte. Append one section in this
shape to the issue body:

```markdown
## Pre-implementation forecast revision

- Revises: Initial forecast
- Agent difficulty: <1-5>/5
- Reasoning novelty: <0-2>/2
- Ownership breadth: <0-2>/2
- Lifecycle/integration burden: <0-2>/2
- Validation burden: <0-2>/2
- Risk: <Low|Moderate|High|Critical>
- Estimate confidence: <Low|Medium|High>
- Rationale: <material scope change and resulting forecast>
```

Preview the exact updated body and intended Project values, then obtain explicit approval for the
issue edit. The revision is a new authorized planning run with new measurement keys. After the
edit, append that run's measurement and re-project. If implementation has started, do not append
a forecast revision or overwrite the initial forecast.

## Deterministic fixtures

Use these fixtures to check the workflow without external writes:

| Fixture | Inputs | Required state and effects |
| --- | --- | --- |
| Authorization boundary | A finding exists, but the maintainer has not authorized this skill. | No baseline, research, draft, reviewer, issue, ledger, or Project operation. |
| Draft approval only | Issue work is authorized and previewed; publication approval is absent. | A baseline may exist. No final snapshot, issue creation, ledger append, or Project write occurs. |
| Changed preview | The maintainer changes title, body, or labels after preview. | Re-preview the exact changed draft. Prior approval does not authorize publication. |
| Successful publication | Qualified start and end snapshots are complete; creation, append, and projection confirm success. | One issue URL, one active drafting record, forecast-derived fields, exact planning total, and a complete handoff. |
| Telemetry unavailable | Exact run identity or a supported snapshot is unavailable. | Publication continues after approval. One unavailable record is appended. No guessed counters or exact planning total appears. Handoff says unavailable. |
| Reviewer unavailable | Drafting delta is complete; a separately authorized reviewer has no attributable counters. | Append the complete drafting record and an unavailable reviewer record. Project coverage and handoff remain partial. |
| Creation rejected | The fixed create request conclusively fails. | No issue checkpoint, append, or projection exists. A retry uses only the unchanged approved draft. |
| Creation uncertain | The create request has no conclusive result. | No second create request. Stop for read-only resolution and report uncertainty. |
| Append rejected | Creation returned an issue URL; the append did not succeed. | Retain the issue. Retry the same append with the same key. Never recreate the issue or invent a new record. |
| Append uncertain then observed | Creation returned an issue URL; the first append was uncertain; retry reports duplicate. | Treat the original record as active exactly once and continue to projection. |
| Project partial write | Every intended record is active; one named Project write fails after earlier writes. | Retain the ledger and preceding writes. Retry only projection from current Project state. |
| Material scope revision | An existing aligned issue changes materially before implementation. | Preserve `Initial forecast`, append one approved revision section, append a new planning run, and re-project. |
| Late scope revision | Implementation has started. | Do not append or replace a forecast. Return the scope change for issue alignment. |

These fixtures prove contributor-workflow policy only. Provider parsing, ledger idempotency,
append uncertainty, pagination, Project writes, and partial Project failure remain covered at
their existing owning seams.
