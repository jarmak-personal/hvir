# ADR-021: System Git decides dirty navigation safety

## Context

ADR-005 permits only branch switches and fast-forward pulls from a clean worktree.
This rejects safe navigation whenever the repository contains staged, unstaged, or
untracked content, even when the target operation does not touch that content.

System Git already validates the index and worktree against the exact target of a switch
or fast-forward. A separate cleanliness rule cannot distinguish safe changes from
collisions. A more detailed hvir preflight would duplicate Git semantics and could become
stale before the mutation runs. Unsaved hvir viewer buffers remain different because Git
cannot inspect content that exists only in renderer memory.

## Decision

An explicit switch among existing local branches and an explicit behind-only,
fast-forward-only pull may run with staged, unstaged, or untracked content. The exact
system Git mutation decides whether it can preserve the index and worktree. Hvir does not
implement a separate path-collision model.

Existing navigation guards remain in force. A branch target must exist locally and must
not be checked out in another worktree. Pull requires a current branch with a present
upstream that is behind and not diverged. Unsaved viewer buffers block both mutations
before IPC because Git cannot protect them.

Git execution remains off the renderer thread behind `GitEngine` and `ProjectHost`.
Exact command grammars, single-use root-qualified authorization, and non-interactive pull
execution remain unchanged for local and SSH hosts. Hvir surfaces Git's refusal and
refreshes project and renderer Git state after success or failure because a refused pull
may still update remote references.

This record supersedes only ADR-005's clean-worktree requirement and its rule that every
dirty branch switch or pull is handed to the terminal. ADR-005's system Git engine,
process boundary, authorization, bounded mutation set, and integration restrictions
remain in force.

## Consequences

Users can navigate when Git can preserve their local work. A successful branch switch may
carry staged, unstaged, and untracked content to the target branch, which matches normal
Git behavior after an explicit user action.

Collision feedback occurs after the user requests the operation. A refusal preserves the
current branch, index, and worktree files, while a pull may refresh remote references or
`FETCH_HEAD`. Refresh after either result keeps hvir's visible state truthful.

## Rejected alternatives

- Retaining the clean-worktree gate, because it rejects safe and common repository states.
- Reimplementing checkout and fast-forward collision checks, because that duplicates Git
  semantics and introduces a time-of-check race.
- Automatically stashing or committing changes, because that expands navigation into
  worktree management and changes user-owned state.
- Forcing an operation past Git's refusal, because that can overwrite local work.
