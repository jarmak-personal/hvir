# Epic delivery

Use this workflow for a direct child of an authorized open `kind:epic`.

## Select the branch

1. Read the child and parent with `project:record`.
2. Confirm the native parent relationship and the parent's valid `kind:epic` label.
3. Confirm the maintainer-authorized child set.
4. Resolve one remote branch named `epic/<parent-number>-<slug>`.
5. Use that branch as the child's exact base.

The workflow that starts a new epic may create the branch from current `origin/main`. Use a short
lowercase ASCII slug. Validate the ref with `git check-ref-format --branch`. Keep the epic branch
history append-only. Report a blocker when metadata, refs, or worktrees conflict.

## Integrate a child

The epic authorization covers child PR publication, check remediation, merge into the epic
branch, and child closure. Keep work within the authorized child set. Target the selected epic
branch. Replace `Closes` with these exact lines:

```text
Contributes-to: #<child>
Contributes-to: #<epic>
```

Confirm the PR base and pushed head. Wait for each required check and inspect its result. Merge the
focused child PR after all gates pass.

Fetch the epic branch. Confirm these facts after merge:

1. The PR merged into the selected epic branch.
2. The recorded PR head matches the verified head.
3. The remote epic branch contains the merge result.
4. The open child still names the same open epic as its native parent.

Close the child with `gh issue close <child> --reason completed`. Re-read the issue and confirm
`CLOSED`. The existing issue-close workflow owns Project `Done`. Keep the issue open when evidence
differs. Report the blocker. Reopen the child when a correction makes it incomplete.

## Hand off the epic

Start cumulative acceptance after every intended child is closed and every child contribution PR
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
