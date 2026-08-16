---
name: hvir-create-issue
description: Evaluate a proposed hvir bug, feature, refactor, documentation change, or maintenance task against the product design and ADRs, help the reporter sharpen it, and prepare a focused GitHub issue. Use only after the user explicitly asks to use this skill or gives an agent's proposal to use it a clear go-ahead. Do not invoke it merely because a potentially reportable finding appears.
---

# Create an hvir issue

Turn an observation or idea into an issue that is worth discussing before code starts. Be
opinionated about product fit and precise about what is known, while preserving unresolved
questions for the issue discussion.

## Require authorization before doing work

Do not research, evaluate, or draft an issue until the user explicitly asks to use this skill
or clearly approves an agent's proposal to use it. Discovering a bug, improvement, or possible
follow-up is not authorization. In that situation, offer at most one brief sentence such as
“I can use `hvir-create-issue` to evaluate and draft this if you want,” then stop that workflow.

Treat drafting and publishing as separate approvals:

1. The first approval authorizes product research and an issue draft.
2. After presenting the exact title, body, and labels, ask whether to create the issue.
3. Only a clear user approval after that preview authorizes the external write.

Do not infer either approval from silence, the usefulness of the finding, a general preference
for issue-first development, or permission granted for a different issue.

After the first approval, read
[`references/issue-planning-measurement.md`](references/issue-planning-measurement.md) completely
and start its private planning-run record before product research. Attempt the provider-qualified
baseline at that boundary. Missing measurement evidence never blocks issue work. Do not capture
or reconstruct usage for brainstorming that happened before authorization.

## Establish context

1. Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/design.md`, and the ADR index.
2. Read the ADRs that govern the affected product area or seam.
3. Inspect relevant local code or documentation when it helps test the proposal against the
   product as it exists.
4. Ask only for missing information that materially changes the problem, scope, or fit. Make
   and state reasonable assumptions for smaller gaps.

Do not treat the reporter's proposed solution as the requirement. First identify the user or
contributor problem and the observable outcome.

## Classify product fit

State one of these conclusions before drafting:

- **Aligned:** the outcome reinforces hvir's view-first, agent-aware workbench.
- **Needs design discussion:** it may fit, but a product boundary or durable architecture
  choice is unresolved.
- **Conflicts with current direction:** a design guardrail or ADR rejects the proposed
  approach. Name the exact conflict and recast the issue as a proposal to revisit that
  decision only if the reporter intends that discussion.
- **Out of scope:** the outcome would turn hvir into an IDE, editor, extension platform,
  task runner, or session orchestrator, or otherwise violates an explicit non-goal. Explain
  this directly instead of manufacturing an implementation issue.

An ADR records an accepted decision, not an eternal ban on discussing it. Distinguish a
deliberate proposal to supersede a decision from an implementation that would silently
violate it.

## Shape the issue

Keep one issue to one focused outcome. If the request is an epic, define the coordinating
outcome and split implementation into child issues with clear ownership and dependency order.
Give each child one focused pull request.

Use natural prose in Problem and Product fit when it helps readers understand the experience,
the story, and why the work matters. Natural prose is the default for these two sections. Keep
factual claims specific. Clearly separate known facts from interpretation.

Use Simplified Technical English for all operational and technical content. This includes
reproduction steps, Expected behavior, Actual behavior, Desired outcome, implementation details
and constraints, Design and architecture questions, Acceptance criteria, and Non-goals. Use
short, literal sentences. Prefer active voice and positive statements or commands. Put one
requirement in each sentence. Use the same term for the same concept. Use literal terms instead
of idioms, rhetorical language, vague modifiers, or unnecessary synonyms. Reserve negative
commands for an essential prohibition, trust boundary, or explicit non-goal.

Keep the draft easy to scan in one pass. Include only the information needed to align on the
problem, boundaries, and observable completion. Do not repeat a requirement across sections.
For a bug, treat Expected behavior as the desired outcome and omit a duplicate Desired outcome
section. Keep Product fit brief when alignment is clear. Record only unresolved architecture
questions. Do not convert reconnaissance findings into prescribed implementation. Use the
minimum acceptance criteria needed to prove the outcome and important failure behavior.

Use this structure, omitting sections that truly do not apply:

```markdown
## Problem

What is difficult, broken, or missing? Who encounters it, and in what workflow?

## Product fit

How does this support hvir's view-first thesis? Which non-goals and ADRs constrain it?

## Desired outcome

Describe observable behavior without prematurely prescribing the implementation.

## Design and architecture questions

Record unresolved choices, likely seams or owners, and any ADR that may need to be added or
superseded before implementation.

## Acceptance criteria

- Concrete, externally observable result
- Important failure, cleanup, responsiveness, local/SSH, or trust-boundary behavior
- Evidence needed to demonstrate completion

## Non-goals

- Tempting adjacent work that this issue intentionally excludes
```

For bugs, also include minimal reproduction steps, expected behavior, actual behavior, and
the relevant platform or host type. For refactors, name the behavior that must remain stable
and the ownership or dependency problem being corrected. Do not use line count alone as the
reason for a refactor.

Acceptance criteria must test the outcome. They must not require a file-by-file design. Include
local and SSH parity, responsiveness, resource cleanup, and security behavior when the affected
capability creates those risks. Do not add criteria that are unrelated to the identified risks.

Every draft that this skill prepares for publication also contains exactly one
`Initial forecast` section. Apply the rubric in
[`docs/agent-work-measurements.md`](../../../docs/agent-work-measurements.md) without
overriding its derived difficulty. Keep the four factors, three headline values, and one concise
rationale in this exact parseable shape:

```markdown
## Initial forecast

- Agent difficulty: <1-5>/5
- Reasoning novelty: <0-2>/2
- Ownership breadth: <0-2>/2
- Lifecycle/integration burden: <0-2>/2
- Validation burden: <0-2>/2
- Risk: <Low|Moderate|High|Critical>
- Estimate confidence: <Low|Medium|High>
- Rationale: <specific reason for the factors, risk, and uncertainty>
```

File count, line count, commit count, and test count are not forecast inputs. An epic carries its
own coordination forecast; its direct children carry their own implementation forecasts.

When a separately authorized `hvir-review-issue` run participates in planning, keep its findings
policy and approval behavior unchanged. Treat it as a separate `issue-planning` run for
measurement. Record truthful counters when the reviewer exposes a qualified supported-provider
run. Otherwise prepare an unavailable reviewer record and report overall planning coverage as
partial; never attribute the drafting harness's counters to the reviewer.

## Preview and create

Present the exact title, body, and applicable repository labels. List assumptions and open
questions separately. In the same preview, show the intended canonical Project values:

- the exact `Agent difficulty`, `Risk`, and `Estimate confidence` values from the forecast;
- `Initial model`, `Reasoning effort`, `Model route`, `Planning tokens`, and
  `Own lifecycle tokens`, which the active ledger will derive after publication and which remain
  explicitly pending, partial, or unavailable when they are not yet known; and
- that implementation, first-pass, time-to-candidate, and epic-rollup fields are not written by
  this planning operation.

Stop after the preview and request explicit publication approval. Once the user approves the
exact draft, create it in `jarmak-personal/hvir` when GitHub issue tooling is available;
otherwise return the approved, copy-ready draft. Never publish a materially changed title,
body, or label set without previewing it again.

After publication approval, take the final planning snapshot immediately before the fixed issue
creation operation. Do not do more research, drafting, revision, or review between that snapshot
and creation. If telemetry is partial or unavailable, continue publication and preserve only the
truthful state.

Treat a returned issue number and URL as the irreversible publication checkpoint. Store them in
the private run state before any measurement append or Project operation. Append every intended
planning run with the existing idempotent repository measurement operation, then derive Project
values from the active ledger. Review each dry run before applying it. If a post-creation step
fails, retain and report the created issue and resume that exact step against the same issue and
idempotency key. Never run issue creation again for that planning run. If creation has an
ambiguous result, stop and resolve it with read-only evidence; do not risk a duplicate.

Report the issue URL plus the outcome of the final snapshot, issue creation, each ledger append,
and Project projection. Use complete, partial, or unavailable exactly as the measurement contract
defines them. Remove the exact temporary snapshot artifact after finalization or abandonment.

If material scope changes after publication but before implementation, preserve the first
forecast. Preview an updated body that appends one `Pre-implementation forecast revision` section
in the same parseable shape, obtain explicit approval for that edit, record the revision planning
as a new run, and re-project from the active ledger. Do not add a forecast revision after
implementation starts.

Never start implementation as part of this skill; the issue discussion is where alignment
happens.
