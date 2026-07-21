# Issue worktree lifecycle

Use the repository-owned command from any checkout in the repository. The governing workflow
must supply the already-agreed full base ref; this capability does not choose `main`, an epic
branch, or another delivery topology.

```sh
npm run issue:worktree -- --issue <number> --base <full-ref>
npm run issue:worktree -- --issue <number> --base <full-ref> --apply
```

The first command is a dry run. It still fetches and prunes `origin`, then reports safe cleanup,
retained exceptional state, and the issue worktree it would create or reuse. Review that report
before applying it. The apply command performs only the reported safe cleanup and creation; it
does not change the invoking checkout.

Continue the entire implementation lifecycle from the selected `path` in the JSON report:
reconnaissance, edits, focused checks, final verification, commits, candidate-review handoff,
pre-push checks, and push. Do not switch, clean, reset, or reuse the invoking checkout.

The capability owns exactly these local records for issue `N`:

- branch `refs/heads/agent/issue-N`;
- marker `refs/hvir/issue-worktrees/N`;
- Git config under `hvir-issue-worktree.N`; and
- sibling path `<primary-repository>-worktrees/issue-N`.

Creation also configures that branch's same-name `origin` upstream before the remote branch
exists. Push normally from the selected worktree and never bypass the repository pre-push hook.

Do not manually create, adopt, rename, move, unlock, repair, or delete those records. A collision
for the selected issue is a blocker requiring maintainer direction. A retained record for a
different issue is diagnostic and does not block safe unrelated work.

Cleanup requires all of the following after `git fetch --prune origin`:

- canonical workflow marker, metadata, branch, and exact registered path;
- a non-current, attached, unlocked, non-prunable worktree whose HEAD equals the local branch;
- the expected `origin` upstream configuration with its remote-tracking ref gone;
- no tracked or untracked state and no ignored state except the command's explicit dependency,
  build, test, and cache roots;
- exactly one merged PR whose recorded head equals the local head and whose base equals the
  recorded base; and
- no associated open PR.

Cleanup uses unforced `git worktree remove` and compare-and-delete refs. It does not require the
head to be an ancestor of the base, so merge, squash, and rebase strategies are handled through
the PR's recorded head rather than unsafe ancestry guesses. Any missing or ambiguous evidence
retains the worktree with a reason.
