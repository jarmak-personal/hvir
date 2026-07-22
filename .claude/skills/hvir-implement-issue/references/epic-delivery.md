# Epic delivery

Use this workflow for a direct child of an authorized open `kind:epic`.

## Select the branch

1. Read the child delivery record with `issue:context --json`.
2. Confirm the native open parent, its valid `kind:epic` label, and the absence of context
   conflicts.
3. Confirm the maintainer-authorized child set.
4. Use the one exact `epic/<parent-number>-<slug>` base reported by context.

The authorized workflow that starts a new epic may resolve the context's missing-branch conflict by
creating the branch from current `origin/main`. Use a short lowercase ASCII slug. Validate the ref
with `git check-ref-format --branch`. Keep the epic branch history append-only. Rerun context after
creation. Report a blocker when other metadata, refs, or worktrees conflict.

## Integrate a child

The epic authorization covers child PR publication, check remediation, and merge into the epic
branch. Keep work within the authorized child set. Target the selected epic branch. Replace
`Closes` with this exact line:

```text
Completes-child: #<child>
```

Confirm the PR base and pushed head. Wait for each required check and inspect its result. Merge the
focused child PR after all gates pass.

Fetch the epic branch. Confirm these facts after merge:

1. The PR merged into the selected epic branch.
2. The recorded PR head matches the verified head.
3. The remote epic branch contains the merge result.
4. The child names the same open epic as its native parent.

Trusted default-branch automation validates those facts, closes the direct child, and converges
Project `Done`. Re-read the child and confirm `CLOSED`. Keep it open and report the automation
conflict when evidence differs. Reopen the child when a correction makes it incomplete.

## Hand off the epic

Start cumulative acceptance after every intended child is closed and every child completing PR
is merged. Confirm that no open PR targets the epic branch. Create or reuse
`<primary-root>-worktrees/epic-<number>` for the exact epic branch. Merge current `origin/main`
into it. Keep the existing epic history. Stop when conflict resolution would change product
intent.

Run fresh verification for the complete `main...epic` candidate. Commit the candidate. Pass the
pre-push hook. Open the final PR to `main` with `Closes #<epic>`.

Return control to the maintainer for acceptance and merge. After final merge, confirm the final
PR, exact heads, clean worktree, deleted upstream, and absence of open PRs that target the epic
branch. Then remove the epic worktree and branch with native Git. Retain state when a cleanup fact
is uncertain.
