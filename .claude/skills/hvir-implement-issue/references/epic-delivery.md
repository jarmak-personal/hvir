# Epic-child delivery

Use this workflow for a direct child of an authorized open `kind:epic`.

## Select the exact base

1. Plan and apply the child worktree with `issue:start --json` as required by
   `hvir-implement-issue`.
2. Confirm the returned native parent is the authorized open `kind:epic` and the delivery record
   has no conflict.
3. Use only the exact `epic/<parent-number>-<slug>` base and start ref returned by the command.

Return a missing or conflicting epic branch to the coordinator. Do not create, repair, merge, or
clean an epic branch or integration worktree from the child workflow.

## Prepare the focused pull request

The epic authorization covers publication of this child's focused pull request. Keep work within
the aligned child. Target the exact epic branch and use this relationship once instead of
`Closes`:

```text
Completes-child: #<child>
```

Confirm the pull request records the pushed candidate head and exact epic base. Return its current
required-check state in the compact handoff from `hvir-implement-issue`. Do not merge the pull
request, close the child, integrate another child, prepare the cumulative epic, or clean epic
state; `hvir-implement-epic` owns those operations.
