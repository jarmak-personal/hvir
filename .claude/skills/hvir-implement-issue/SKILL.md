---
name: hvir-implement-issue
description: Implement an already-aligned hvir GitHub issue with product and architectural diligence. Use when a governing issue exists and the user wants code or documentation changes, especially work that crosses features, touches established seams, risks duplicating behavior, or could enlarge composition roots and god classes.
---

# Implement an hvir issue

Implement the governing issue without allowing its proposed solution to bypass hvir's
product constraints or architecture. Spend real effort on ownership and decomposition
before editing; raise material concerns while they are still cheap to resolve.

## Require an aligned issue

Start from an issue number plus its current, reviewed problem statement, desired outcome,
and acceptance criteria. If no governing issue exists, stop and use `hvir-create-issue`
before implementation. A large epic should coordinate independently reviewable child
issues, not produce one giant implementation pull request.

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/design.md`, the relevant ADRs, and the governing
issue. Resolve these questions before changing files:

- What user or contributor outcome is being implemented?
- Is the issue aligned with the current product boundaries and accepted decisions?
- Which requirements are settled, and which comments are still exploratory?
- Is a new or superseding ADR required before implementation?
- Is this issue small enough for one coherent review?

If an answer could materially change product behavior, ownership, authority, or scope,
surface it and pause for alignment. Otherwise state the assumption and continue.

## Establish the isolated issue worktree

Obtain the exact agreed base ref from the governing workflow; this skill must not silently
choose between `main`, an epic branch, or another base. Use native Git directly from the
invoking checkout without switching, cleaning, resetting, or overwriting it:

```sh
git fetch --prune origin
git worktree list --porcelain
git worktree add -b "agent/issue-<number>" "<primary-root>-worktrees/issue-<number>" "<base-ref>"
```

Before creating anything, reconcile prior `agent/issue-*` worktrees conservatively with
`git worktree list`, `git status`, ref/upstream checks, and bounded `gh pr list` metadata. Remove
one only when it is not current or locked, its tracked and untracked state is clean, any ignored
content is plainly disposable, its upstream is gone after pruning, and a merged PR records its
exact local HEAD and expected base with no later commits or open PR. Use exact native Git
operations without force or recursive filesystem deletion; compare-and-delete a squash- or
rebase-merged local ref with `git update-ref -d <ref> <expected-head>`. Retain ambiguous state
with a reason, then continue unrelated work unless the selected branch or path collides.

Reuse an existing worktree only when `agent/issue-<number>` is registered at the exact sibling
path above. Stop on any mismatched branch, path, detached state, or ambiguous base. After
selection, perform all reconnaissance, edits, checks, commits, candidate-review handoff, and
push operations from that worktree.

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

After verification passes, commit the exact candidate and decide whether one independent code
review is useful. Invoke `$hvir-review-code` once for a nontrivial feature or refactor, a change
with meaningful architecture, security, concurrency, lifecycle, or cross-seam risk, and the
final cumulative candidate for an epic. Skip it by default for a small localized bug, routine
documentation, test-only change, or mechanical maintenance with no such risk.

Evaluate the single review response. Make the smallest coherent fix for a valid finding and
record concise evidence when rejecting a false positive. Do not re-run the reviewer. If the
candidate changes, rerun appropriate focused checks and a fresh `npm run verify`, then commit
the final candidate before the pre-push gate. Integration checks remain the final authority.

Push without `--no-verify` so `.githooks/pre-push` runs the typechecks and local-platform
Electron smoke. If the repository hook is not installed, run `.githooks/pre-push` directly
before pushing. Do not bypass a failure to spend GitHub Actions minutes discovering the same
problem. Fix and rerun the check, or stop and report an environment blocker to the user.

Use the capacity, real-host, packaged, or full gauntlet checks when the issue's acceptance
criteria require those environments. Report exact results and any unverified environment
honestly.

Before handing off:

1. Review the complete diff for duplicated policy, misplaced authority, widened public APIs,
   missing cleanup, and accidental scope growth.
2. Re-run `npm run architecture:report`; explain intentional growth even when it is below a
   blocking threshold.
3. Check every acceptance criterion against code and evidence.
4. Confirm the mandatory pre-commit verification and pre-push gates passed after the final
   changes, plus any risk-based independent review that was used.
5. Prepare a concise pull-request summary that links the governing issue with `Closes #N`,
   explains architecture and reuse decisions, lists risks, and records verification.

Open or update a pull request only when the user requests it. Never describe the work as
complete while architectural concerns or required validation remain unresolved.
