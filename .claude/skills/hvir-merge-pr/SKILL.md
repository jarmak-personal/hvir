---
name: hvir-merge-pr
description: Merge one explicitly approved hvir pull request through GitHub and reconcile its issue-owned Project fields. Use after a verified ordinary or cumulative epic handoff when the maintainer wants that pull request accepted.
---

# Merge an approved pull request

Treat an explicit `$hvir-merge-pr` invocation as maintainer approval to merge one pull request.
Do not add a second approval boundary or reproduce GitHub's merge policy in repository tooling.

Resolve the pull-request number before acting:

- Use the number supplied by the maintainer when present.
- Otherwise reuse one only when the latest verified lifecycle handoff in the active interaction
  identifies exactly one final pull request.
- Ask for one pull-request number when there is no such handoff or more than one candidate is
  possible.

Never search branches, issues, the Project, or the open pull-request list to guess which pull
request the maintainer meant. The accepted pull-request number is the complete merge authority
input; do not request a separate issue number or candidate SHA.

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/project-management.md`, and ADR-037 before acting. Do
not invoke `hvir-review-code`, open a measurement run, or invent review or usage evidence. Review
and implementation already ended at the verified handoff.

## Request the protected merge

Read only the accepted pull request's base to keep epic-child integration with its existing owner:

```sh
gh pr view <pr> --json baseRefName
```

Require `main`. This is a delivery-route guard, not a second mergeability, check, review, head, or
relationship classifier. Then use GitHub's ordinary merge path directly:

```sh
gh pr merge <pr> --merge --auto
```

Never use `--admin`. The repository ruleset, required checks, review requirements, base freshness,
and GitHub mergeability remain authoritative. `--auto` lets an approved pull request wait for
those requirements instead of turning transient pending or base-refresh state into another
maintainer turn.

Monitor the accepted pull request until GitHub records the merge or reports a durable failure.
Report a failed check, conflict, disabled auto-merge, rejected merge, or other GitHub blocker as
GitHub returned it. Do not manufacture a new commit, change the PR body or relationships, rerun
CI, or bypass protection to make the merge pass.

Ordinary and cumulative root-epic pull requests use this same protected merge request. Epic-child
pull requests remain integrated only by `hvir-implement-epic`; do not use this final-acceptance
skill to merge a child into an epic branch.

## Reconcile Project fields after merge

After GitHub records the merge, read that pull request's native closing relationships and require
one same-repository closing issue. Do not parse closing keywords from body text. If the merged
pull request has no such issue or more than one, preserve the merge and report that Project
reconciliation needs maintainer direction.

```sh
gh pr view <pr> \
  --json state,baseRefName,headRefName,headRefOid,mergeCommit,closingIssuesReferences
```

Converge the closed issue's canonical Project Status directly through the planning-record owner:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run project:record -- --issue <issue> --ensure-project --status Done --apply
```

Then reproject the issue's existing measurement ledger through its named owner:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run project:measure -- --issue <issue> --project --apply
```

For a root epic, also apply its existing non-recursive Rollup projection:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" \
HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run project:measure -- --issue <issue> --rollup --apply
```

Ordinary issues run no Rollup. These operations reconcile existing facts only; they do not create
merge-phase work, review usage, or candidate corrections. A Project or projection failure never
rolls back a successful GitHub merge. Retry only the failed focused reconciliation command from
current state.

Branch and worktree cleanup is not merge admission and does not block acceptance. If cumulative
epic state later needs cleanup, its existing `hvir-implement-epic` owner may perform that work
under separate explicit authority.

## Hand off

Return the pull request, base and head branch, GitHub-recorded head and merge commit SHA, required
check outcome, native closing issue, issue closure, Project Status, measurement projection and
applicable Rollup outcome. Say whether GitHub merged immediately or auto-merge waited, identify
any post-merge reconciliation failure, and confirm that no review usage or merge-phase
measurement was invented.
