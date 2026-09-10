# Report contributor facts

At handoff, read one compact status report. Select the exact PR when known:

```sh
HVIR_REPO_TOKEN="$(gh auth token)" HVIR_PROJECT_TOKEN="$(gh auth token)" \
npm run --silent project:status -- --issue <issue> --pr <pr>
```

At every planning handoff, request capture with `--capture codex --phase planning` (or
`--capture claude-code --phase planning`). For a batch of issues created together, pass
`--issue <one-selected-issue> --issues <comma-separated-issue-numbers>` once. The tool
allocates equal integer shares and deterministic remainders. Review the dry run, then repeat
with `--apply`. If counters or issue identities are unavailable, report the explicit reason;
missing evidence remains unknown and does not block issue publication. End the planning session
at the issue-creation handoff, including a batch. If it continues, later capture assigns only
the newly observed counter difference and preserves previous shares.

For all non-planning work, use `--phase implementation`: implementation, testing, reviews,
corrections, coordination, and acceptance all belong here. Use `--phase unknown` when the
session mixes planning and implementation without a reliable split; its total is preserved
and phase fields remain empty. Implementation capture remains optional. Never classify a
whole mixed session as implementation merely because its latest activity was implementation.

Codex uses its exact current `CODEX_THREAD_ID`; Claude uses `HVIR_USAGE_SESSION_ID`.
Set `HVIR_USAGE_CWD` privately to the exact launch directory when different from the current
worktree. Never use inherited coordinator identity for a delegate, scan neighboring sessions,
construct receipts, calculate shares, or manage keys/checkpoints. Unavailable usage is a fact,
not a recovery assignment. Keep private local attribution state for recaptures; automatic
cross-machine recovery is unsupported.

The tool reports Planning tokens, Implementation tokens, and Total tokens. Historical
contributions survive through migration evidence, and epics aggregate their own and direct
children's allocated contributions once. These are observed counts, not proof of unrecorded
work. Use `--json` only when detailed evidence is needed.

Report Tokens, Project, and Acceptance from the tool, plus implementation evidence and actionable
blockers. Do not infer acceptance from green checks or Done. Handoff is readiness; explicit
`hvir-merge-pr` invocation is approval; protected merge is completion. A later status read can
report approval unknown without reconstructing the conversation.
