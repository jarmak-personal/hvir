---
name: hvir-implement-issue
description: Implement one already-aligned hvir GitHub issue with product and architectural diligence. Use for an ordinary issue or one direct epic child when the user wants code or documentation changes, especially work that crosses features, touches established seams, risks duplicating behavior, or could enlarge composition roots and god classes. Use hvir-implement-epic instead for top-level epic coordination.
---

# Implement an hvir issue

Implement the governing issue without allowing its proposed solution to bypass hvir's
product constraints or architecture. Spend real effort on ownership and decomposition
before editing; raise material concerns while they are still cheap to resolve.

## Require an aligned issue

Start from an issue number plus its current, aligned problem statement, desired outcome,
and acceptance criteria. If no governing issue exists, stop and use `hvir-create-issue`
before implementation. Run a large epic through `hvir-implement-epic`, which coordinates
independently deliverable child issues instead of producing one giant implementation pull request.

Read [`references/agent-work-recording.md`](references/agent-work-recording.md) completely. Open
one `implementation` measurement run at this skill's start observation, before delivery setup or
reconnaissance. Capture a provider start snapshot when the exact current supported session can be
qualified; otherwise retain the truthful fixed unavailable reason. Measurement failure never
blocks the implementation workflow.

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/design.md`, the relevant ADRs, and the governing
issue. Resolve these questions before changing files:

- What user or contributor outcome is being implemented?
- Is the issue aligned with the current product boundaries and accepted decisions?
- Which requirements are settled, and which comments are still exploratory?
- Is a new or superseding ADR required before implementation?
- Is this issue small enough for one focused pull request?

If an answer could materially change product behavior, ownership, authority, or scope,
surface it and pause for alignment. Otherwise state the assumption and continue.

## Select the delivery path and isolated worktree

Supply credentials through the environment described in `docs/project-management.md`. Plan the
complete startup, review the result, then apply a freshly recomputed plan:

```sh
npm run issue:start -- --issue <number> --json
npm run issue:start -- --issue <number> --apply --json
```

The command refreshes/prunes remote refs, reads the normalized issue, parent, expected base,
deterministic branch and worktree, planning state, and open PRs, conservatively reconciles prior
workflow-owned issue worktrees, creates or reuses the selected worktree, and prepares locked
dependencies. Planning changes only remote-tracking refs. Apply retains partial or ambiguous state
with reasons and never mutates Project membership, Kind, or Status.

- Use `origin/main` when context selects ordinary delivery with base `main`. Target `main`. Add
  `Closes #<number>` to the PR.
- When context selects epic-child delivery, read
  [`references/epic-delivery.md`](references/epic-delivery.md) completely and follow it. Use the
  exact epic base from context.

Stop on context conflicts. Only an authorized `hvir-implement-epic` coordinator may create the
first epic branch; a child returns that missing-branch blocker instead of creating it. The startup
command itself never creates or pushes an epic branch. Record the returned issue, parent, PR base,
start ref, branch, worktree, selected HEAD, and delivery path before work begins. After selection,
perform all reconnaissance, edits, checks, commits, and push operations from that worktree.

## Perform architecture reconnaissance

Inspect before planning:

1. Trace the current behavior end to end across renderer, preload, main, workers, and host
   adapters as applicable.
2. Identify the existing product-capability owner, stable public seam, and resource owner.
3. Search for semantically equivalent policies, helpers, types, validators, subscriptions,
   cleanup paths, and tests. Search by behavior as well as by the proposed symbol names.
4. Inspect callers and neighboring features so a locally convenient change does not create
   a reversed dependency or duplicated authority.
5. Run `npm run architecture:report` and inspect `scripts/architecture-hotspots.json` before
   adding responsibility to a named hotspot or composition root.
6. Locate tests at the seam that owns the behavior and higher-altitude coverage for Electron,
   Chromium, process, lifecycle, SSH, or real-transport contracts.

Give the user a compact pre-implementation assessment: proposed owner, dependency direction,
reuse opportunities, lifecycle implications, test altitude, and any concern that needs a
decision. Do this before substantive edits.

## Design the smallest coherent change

Follow ADR-014 and the public seams in `AGENTS.md`:

- Organize by product capability. Entry points and roots construct, wire, start, and dispose;
  they do not absorb workflows or feature policy.
- Keep dependency direction inward toward stable policy and narrow ports. Concrete Electron,
  filesystem, Git, PTY, provider, preview, and SSH behavior stays at the edge.
- Put cross-feature workflows in explicitly named coordinators with narrow ports. Do not add
  service locators, generic `utils`, or catch-all `services` modules.
- Extract shared behavior when multiple consumers represent the same stable concept. Place it
  at the lowest layer both consumers may depend on, give it a domain name, and test its policy
  once. Similar-looking code with different ownership or authority may be intentionally
  separate; explain that decision instead of forcing reuse.
- Do not split files merely to satisfy line counts. Split responsibilities, policy, effects,
  adapters, and views along ownership boundaries.
- Model resource lifetimes explicitly. Revocation must reject late async completion; disposal
  must be idempotent and reverse ownership order.
- Keep every project path host-qualified and preserve local/SSH parity through `ProjectHost`.
- Keep heavy work off the render thread and harness-specific behavior behind providers.

Prefer a sequence of focused changes that each leaves the system coherent. If the work reveals
separable prerequisites or cleanup, propose additional issues rather than silently expanding
the current one.

## Implement and verify

Preserve unrelated work in the tree. Add or update tests at the owning seam as behavior is
implemented. Test pure policy directly, consumers through narrow fake ports, adapters at their
immediate external boundary, and environment contracts at integration or smoke altitude.

Run the most focused checks during development. Treat `npm run verify` as a mandatory
pre-commit gate: run it after the final changes and do not commit, push, or open a pull request
until it passes. A passing run from before later edits is stale and does not satisfy the gate.

After verification passes, commit the exact candidate. If the candidate changes, run the relevant
focused checks and a fresh `npm run verify`. Commit the final candidate before the pre-push gate.

Push without `--no-verify` so `.githooks/pre-push` runs the typechecks and local-platform
Electron smoke. If the repository hook is not installed, run `.githooks/pre-push` directly
before pushing. Do not bypass a failure to spend GitHub Actions minutes discovering the same
problem. Fix and rerun the check, or stop and report an environment blocker to the user.

Use the capacity, real-host, packaged, or full gauntlet checks when the issue's acceptance
criteria require those environments. Report exact results and any unverified environment
honestly.

The first candidate boundary is not reached until final local verification, commit, the pre-push
gate, and a successful normal push all apply to the same candidate. At that point, immediately
take the run's final provider snapshot and stop its active-wall and time-to-first-candidate
accumulators. Use the pushed commit SHA as the bounded candidate reference. A first handoff is
`pending` unless acceptance is already explicit; do not infer `accepted` from passing checks or
review sentiment. A run that ends without a candidate records `no-candidate`.

Every later in-scope correction, including review-driven correction, starts a new invocation and
a new `implementation` run. Record `rework-required` with its new pushed candidate, preserve that
sticky fact, and omit time to first candidate because the earliest candidate already established
it. Do not attribute correction usage to `implementation-review`.

## Publish and hand off

Use the user's authority to open or update an ordinary pull request. For an epic child, follow
`references/epic-delivery.md` only through focused child pull-request preparation. The
`hvir-implement-epic` coordinator owns child integration, closure checks, cumulative delivery,
and cleanup; never perform those responsibilities from this skill.

Before handing off:

1. Inspect the complete diff for duplicated policy, misplaced authority, widened public APIs,
   missing cleanup, and accidental scope growth.
2. Re-run `npm run architecture:report`; explain intentional growth even when it is below a
   blocking threshold.
3. Check every acceptance criterion against code and evidence.
4. Confirm that the mandatory pre-commit verification and pre-push gates passed after the final
   changes.
5. Prepare a concise pull-request summary with the relationship selected by the delivery path,
   architecture and reuse decisions, risks, and verification.

Open or update a pull request when the user requests it or an authorized epic coordinator launches
the child. Report unresolved architecture or validation concerns as blockers.

Finalize the implementation measurement only after the candidate handoff facts above are stable,
then append the record and reconcile its named Project projection using
`references/agent-work-recording.md`. Append before projection. Retry an uncertain append with the
same record and key; retry a post-append projection without appending. Partial, unavailable, or
failed measurement is reported but does not suppress the implementation handoff.

Return a compact implementation handoff for both ordinary and epic-child work. Include:

- issue number and native parent, if any;
- completing model family for review selection, plus the exact observed initial model and
  requested/effective reasoning effort when available;
- exact start base and candidate commit SHAs;
- pull-request number, base, head branch, and recorded head SHA;
- changed product owners, authoritative seams, and actual write set;
- final `npm run verify` and pre-push evidence;
- implementation measurement availability, route changes/escalation, append/idempotency state,
  projected Implementation/Own state, unavailable counters, active time, first-candidate time,
  and first-pass outcome without private provider identity;
- CI and external-review state;
- deviations from the issue or expected architecture; and
- blockers or unresolved concerns.

An ordinary handoff goes to the maintainer. An epic-child handoff goes to the coordinator, which
validates the evidence and applies `hvir-review-code` selection policy. This skill does not invoke
that review merely because it is implementing an epic child.
