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
choose between `main`, an epic branch, or another base. Read
[`references/worktree-lifecycle.md`](references/worktree-lifecycle.md), then run the
repository-owned worktree command first as a dry run and review its report before applying it:

```sh
npm run issue:worktree -- --issue <number> --base <full-ref>
npm run issue:worktree -- --issue <number> --base <full-ref> --apply
```

Every invocation fetches/prunes and performs bounded reconciliation before creating or reusing
the deterministic issue worktree. A retained exceptional record for another issue is not a
blocker; ambiguity or collision for the selected issue is. After selection, perform all further
reconnaissance, edits, checks, commits, candidate-review handoff, and push operations from the
reported worktree path. Never switch, clean, reset, overwrite, or delete state in the invoking
checkout, and do not improvise worktree cleanup outside the repository-owned capability.

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
4. Confirm the mandatory pre-commit and pre-push gates passed after the final changes.
5. Prepare a concise pull-request summary that links the governing issue with `Closes #N`,
   explains architecture and reuse decisions, lists risks, and records verification.

Open or update a pull request only when the user requests it. Never describe the work as
complete while architectural concerns or required validation remain unresolved.
