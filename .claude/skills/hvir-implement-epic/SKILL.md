---
name: hvir-implement-epic
description: Coordinate an authorized hvir epic through parallel child implementation, coherence review, staged integration, cumulative verification, maintainer handoff, and exact post-merge cleanup. Use when a maintainer explicitly asks to implement an aligned open kind:epic and authorizes its direct child set.
---

# Implement an hvir epic

Act as the private epic coordinator: staff TPM and system architect for one authorized epic. Own
scheduling, cross-child coherence, review selection, integration, cumulative delivery, and exact
cleanup. Do not implement or patch child feature code. Keep the dependency graph, scheduling
notes, agent messages, and review transcripts inside the agent run; GitHub receives only curated
issues, focused pull requests, required relationships, lifecycle results, and maintainer-facing
summaries.

## Establish authority and scope

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/design.md`, the relevant ADRs, the epic, and every
proposed direct child before changing Git or launching a child. Use the repository and Project
interfaces from `docs/project-management.md` to confirm:

- one aligned, open issue with exactly one `kind:epic` label;
- its native direct children and their current open/closed and Project states;
- the exact child set the maintainer authorized for this run; and
- no nested epic, cross-repository child, materially changed outcome, or unresolved product or
  architecture decision.

Treat an explicit invocation for the epic as authorization for its current direct child set only
when that set is unambiguous in the aligned epic record. Ask the maintainer to confirm any
ambiguous or changed set. New scope and materially changed child outcomes require issue alignment
and fresh authorization. Do not post routine coordination updates to GitHub.

## Establish the epic branch

Supply credentials only through the environment documented in `docs/project-management.md`.
Fetch and prune remote refs, inspect local and remote `epic/<epic-number>-*` refs, and inspect
registered worktrees before selecting anything. Preserve the invoking checkout's branch and
working state; perform epic work only in the deterministic epic worktree.

Reuse one branch only when it is the sole matching live branch, its local and remote identities
are compatible, and any existing epic worktree is registered at
`<primary-root>-worktrees/epic-<epic-number>` on that exact branch. Stop on multiple branches,
divergent local and remote heads, a mismatched path or branch, a detached worktree, uncommitted
state that the workflow does not own, or any other ambiguous state.

When no matching branch exists, derive one short lowercase ASCII slug from the epic title as
data, form `epic/<epic-number>-<slug>`, and validate it with `git check-ref-format --branch`.
Create it from current `origin/main` in the deterministic epic worktree and push it normally.
Never execute issue text as shell source. Keep epic history append-only: never force-push,
rewrite, or rebase the branch. Prepare locked dependencies in the selected epic worktree before
using it for cumulative verification.

After the branch exists, use read-only delivery context to confirm every open authorized child
selects that exact epic branch and native parent without conflicts. Do not apply `issue:start`
from the coordinator. Each launched child's `hvir-implement-issue` workflow plans and applies
`issue:start --json` for its own issue worktree and dependencies.

## Build the private delivery graph

Before launching any child, keep one bounded in-session record with a row for each authorized
child:

- issue number, acceptance outcome, state, and explicit prerequisites;
- current product owner, authoritative seam, and expected write set;
- shared integration files or contracts it may affect;
- base SHA, candidate SHA, pull request, and CI state once available;
- completing model family and external-review state; and
- deviations, blockers, and readiness.

Derive prerequisites from explicit issue dependencies and required acceptance order. Inspect the
existing owners, seams, callers, tests, and relevant ADRs to estimate write sets before launch.
Add a serialization edge when children depend on one another, share an owner or authoritative
seam, have intersecting expected write sets or integration files, or have an uncertain
interaction. Do not remove an edge merely to fill capacity.

Discover the delegation slots exposed by the active harness. Reserve the root slot for the
coordinator and use only the remaining slots; add no capacity setting or orchestration state.
Schedule the next wave from graph-ready children, running only independent children concurrently.
A blocked child withholds its dependents but does not stop unrelated ready work.

## Delegate child implementation

Launch one child agent per issue with an instruction that explicitly invokes the accepted child
workflow, for example:

```text
Use $hvir-implement-issue #<child>. This is an authorized direct child of epic #<epic>.
Return the compact implementation handoff required by that skill when the focused PR is ready.
```

Do not copy, summarize, or replace `hvir-implement-issue` in the launch message. That skill owns
reconnaissance, scope, `issue:start`, implementation, tests, verification, commit, push, and the
focused child pull request. The coordinator remains available to schedule, validate, review, and
integrate. If the child workflow is missing or unreliable, stop and improve
`hvir-implement-issue` or `issue:start` through aligned work; do not invent a second procedure or
patch around it from the epic root.

Send in-scope corrections back to the same child through an explicit
`$hvir-implement-issue #<child>` follow-up. That workflow owns the correction, focused checks,
fresh `npm run verify`, commit, push, and renewed CI evidence. Escalate a correction that changes
product behavior, architecture authority, scope, or the aligned child outcome to the maintainer.

## Validate and review each candidate

Require this compact private handoff from every child:

- issue and native parent;
- completing model family;
- exact start base and candidate commit SHAs;
- pull-request number, base, head branch, and recorded head SHA;
- changed product owners, authoritative seams, and actual write set;
- final `npm run verify` and pre-push evidence;
- CI and external-review state;
- deviations from the issue or predicted graph; and
- blockers or unresolved concerns.

Cross-check the handoff instead of trusting prose. Inspect the candidate worktree and commit,
the complete base-to-candidate diff, current issue and parent records, pull-request base/head/state
and completing relationship, and required checks. Reconcile the actual write set and changed
owners against the graph and every already-integrated child.

Invoke `$hvir-review-code` once when its selection policy marks a child nontrivial or high-risk.
Supply the child's completing model family so the review uses a different family. Keep the review
transcript private. Route actionable corrections through the same child workflow. Do not
integrate an unresolved blocking finding; stop for maintainer judgment when a finding concerns
product intent, scope, or architectural authority.

Review every child against both its issue and the epic goal. Reject scope creep, duplicated
policy, misplaced ownership, incompatible public seams, missing acceptance evidence, and work
that consumes another child's responsibility. A base change invalidates a later candidate when
it touches that child's prerequisites, owner, seam, expected write set, integration files, or
when the interaction is uncertain. Return an invalidated candidate through
`hvir-implement-issue` for an update and fresh gates.

## Integrate one child at a time

Immediately before each merge, re-read and confirm:

1. the candidate commit is the exact pushed pull-request head;
2. the pull request targets the current epic branch;
3. every required check is successful for the current candidate;
4. the child still names this open epic as its native direct parent;
5. the pull request contains the one exact `Completes-child: #<child>` relationship; and
6. all review findings and graph conflicts are resolved.

Merge only that focused pull request into the epic branch. Fetch afterward and confirm that the
pull request records the verified head and epic base, the remote epic branch contains the merge
result, trusted automation closed the child, and its Project state converged to `Done`. Stop on
any mismatch or automation conflict; never infer closure from the merge alone.

Update the private graph after every merge and after each completed wave. Re-evaluate remaining
bases, dependencies, owners, seams, write sets, and blockers before releasing more work. Review
the integrated wave against its child issues and the epic goal for scope and coherence before
starting the next wave.

## Prepare the cumulative candidate

Begin cumulative delivery only after every authorized child is closed, every completing pull
request is integrated, and no unexpected open pull request targets the epic branch. In the clean
deterministic epic worktree, fetch current `origin/main` and merge it into the epic branch. Do not
rebase or rewrite history. Stop when conflict resolution would require feature work or product
judgment; route an in-scope correction to its owning child.

Review the complete `origin/main...epic` outcome against the epic goal, every child acceptance
criterion, ownership boundaries, and unresolved findings. Run fresh `npm run verify` on the exact
committed cumulative candidate. Invoke `$hvir-review-code` once on that candidate using the
coordinator's completing model family, and resolve findings through the owning child workflow.
After any correction or newly integrated child, restart cumulative checks from current
`origin/main`.

When the cumulative candidate is unchanged and clean after review, push normally so the
pre-push hook runs. Open or update one final pull request to `main` with `Closes #<epic>`. Confirm
its exact head and base, then return the exact candidate SHA and curated acceptance evidence to
the maintainer. Stop before the final merge; cumulative acceptance and the merge to `main` belong
to the maintainer.

## Resume for exact cleanup

After the maintainer reports the final merge, resume the coordinator and fetch/prune. Confirm all
of these facts before removing anything:

- the final pull request is merged into `main` and records the handed-off epic head;
- current GitHub state contains no open pull request targeting the epic branch;
- the local epic branch and deterministic worktree are still the expected identities;
- the epic worktree has no tracked, untracked, or ambiguous ignored state; and
- the remote epic branch is absent, or still points to the exact handed-off head and can be
  deleted with an exact lease.

If the remote branch remains at the exact expected head, delete only that remote ref with a
lease, then fetch/prune and confirm its absence. Remove the registered epic worktree without
force and compare-and-delete the local branch only at its expected head. Never recursively delete
the path. Retain uncertain or changed state for maintainer action and report the exact reason.
