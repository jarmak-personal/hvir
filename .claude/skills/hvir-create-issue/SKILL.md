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

Keep one issue to one independently reviewable outcome. If the request is an epic, define
the coordinating outcome and split implementation into child issues with clear ownership
and dependency order. Do not let a broad issue become permission for one monster pull
request.

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

Acceptance criteria must test the outcome rather than echo a proposed file-by-file design.
Include local/SSH parity, responsiveness, resource cleanup, and security behavior when the
affected capability makes them relevant; do not add ceremonial criteria.

## Review and create

After preparing the exact proposed title, body, and labels, invoke `$hvir-independent-review` in
issue mode with the completing model family and trusted reporter outcome. Evaluate both
independent outputs, correct valid findings, and record concise evidence for rejected false
positives. Any draft change invalidates both reviews and requires a complete fresh pass. A
missing, failed, timed-out, malformed, self-family, or permission-widened review blocks the
publication preview rather than silently weakening it.

After two conforming reviews cover one exact draft, present that exact title, body, and any
existing repository labels that clearly apply. Call out assumptions and open questions
separately so the reporter can correct them.

Stop after the preview and request explicit publication approval. Once the user approves the
exact draft, create it in `jarmak-personal/hvir` when GitHub issue tooling is available;
otherwise return the approved, copy-ready draft. Never publish a materially changed title,
body, or label set without previewing it again.

Never start implementation as part of this skill; the issue discussion is where alignment
happens.
