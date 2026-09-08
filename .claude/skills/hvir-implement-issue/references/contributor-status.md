# Report contributor facts

At handoff, read one compact status report. Select the exact PR when known:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run --silent project:status -- --issue <issue> --pr <pr>
```

If the exact current supported session is available, add `--capture codex` or
`--capture claude-code`. Review its dry-run result, then repeat with `--apply`.
That operation records the session's observed total once and synchronizes the issue and
its direct parent's token fields. Repeated capture contributes only the increased total.
One session belongs to one issue; the coordinator session belongs to the epic.

Codex uses its exact current `CODEX_THREAD_ID`; Claude uses the explicitly supplied
`HVIR_USAGE_SESSION_ID`. Set `HVIR_USAGE_CWD` privately to the exact launch directory when
different from the current worktree. Never use inherited coordinator identity for a delegate,
scan neighboring sessions, construct receipts, or manage keys/checkpoints. Missing identity,
an assignment mismatch, or unavailable usage is one fact, not a recovery assignment.

Totals are observed session-attributed estimates since migration, not exact effort or all-time
usage. Keep the private local assignment when recapturing; cross-machine identity recovery is
unsupported. Historical phase records stay separate. Use `--json` only for needed details.

Report Tokens, Project, and Acceptance from the tool, plus implementation evidence and actionable
blockers. Do not infer acceptance from green checks or Done. Handoff is readiness; explicit
`hvir-merge-pr` invocation is approval; protected merge is completion. A later status read can
report approval unknown without reconstructing the conversation.
