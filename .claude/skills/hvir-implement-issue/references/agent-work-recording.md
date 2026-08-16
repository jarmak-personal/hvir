# Record lifecycle agent work

Use this procedure only for work authorized through a repository lifecycle skill. The canonical
vocabulary, schema, exclusions, and phase boundaries remain in
[`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md); the repository
commands remain documented in [`docs/project-management.md`](../../../../docs/project-management.md).

Measurement is optional evidence. A missing snapshot, unavailable Project field, failed append,
or failed projection never relaxes or blocks the lifecycle's normal delivery gates. Report the
measurement failure and continue the authorized work.

## Open one run

At the phase's start observation:

1. Create a new content-free 64-character lowercase hexadecimal `runKey`. A correction, resumed
   execution, or reopened issue is a new run and gets a new key.
2. Derive or create one content-free 64-character hexadecimal `idempotencyKey` for finalizing
   that run. Retain both keys privately until finalization finishes. Repeated finalization of the
   same run reuses the same key; never derive either key from prompts, responses, repository
   content, paths, candidate content, or a provider session identifier.
3. Start a monotonic active-wall accumulator. Exclude only explicit suspension while awaiting
   maintainer input or acceptance; include tools, checks, pushes, and external model/API work.
4. Record the exact initial harness, model identifier, and requested/effective reasoning effort
   exposed by the selected runtime. Omit an unavailable fact rather than replacing it with a
   family name or inferred value.
5. When an exact current Codex or Claude Code session identity and launch directory are privately
   available, capture the provider-owned start snapshot with `proof:harness-usage`. Keep the
   snapshot in a private temporary file and remove it on every exit. Do not print, publish, or put
   the session identity, artifact location, or snapshot path in a record. If exact identity cannot
   be proven, retain the applicable fixed unavailable reason and continue.

Record every explicitly observed route change in order. Preserve the initial route, number
changes contiguously from one, and set `escalation` only when the caller or coordinator explicitly
selected a stronger route. Do not rank model names or infer escalation. A separately delegated
or resumed lifecycle execution is a new run, not a route change.

## Finalize once

At the phase's finalization observation:

1. Stop the active-wall accumulator and, when the qualified start snapshot exists, take the end
   snapshot for the same provider session and calculate the delta with
   `proof:harness-usage`. Never combine nearby or cross-provider sessions.
2. Build one closed schema-v1 record from observed facts only. A complete record includes every
   additive counter and its exact safe-integer normalized total. A partial record includes an
   initial route, at least one usage or timing fact, fixed `missingFacts`, and no normalized total.
   An unavailable record includes one fixed `unavailableReason` and no route, usage, timing, or
   missing-fact claims. The issue, phase, run, and idempotency keys and an allowed implementation
   outcome may still be present.
3. Dry-run the append, inspect the normalized plan, then apply the freshly supplied same record:

   ```sh
   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_AGENT_WORK_RECORD="$agent_work_record" \
   npm run project:measure -- --issue <number> --append

   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_AGENT_WORK_RECORD="$agent_work_record" \
   npm run project:measure -- --issue <number> --append --apply
   ```

4. Only after the append is confirmed or reported as the identical duplicate, dry-run and apply
   the separate Project projection. If projection fails after append, retry projection only; do
   not append again.
5. Report `complete`, `partial`, `unavailable`, `duplicate`, or failed/uncertain append and
   projection state in the lifecycle handoff. Never include the private snapshot or provider
   identity inputs.

An uncertain append is not permission to generate a new key. A later retry re-reads the ledger
and presents the same record and idempotency key so the append operation can establish whether
the original write landed.

## Deterministic lifecycle fixtures

Use these fixtures when classifying records; they supplement the executable ledger and projector
tests without changing the wire schema.

| Scenario | Records and projection consequence |
| --- | --- |
| One implementation run | One `implementation` record has one run key, the exact initial route, the start/end delta, active time, first candidate commit, and `pending`; its exact total projects to `Implementation tokens` and Own. |
| Escalation | The same run retains its initial route and adds contiguous route changes with only the explicitly escalated step marked `true`; all counters still come from that run's qualified start/end snapshots. |
| Multiple corrections | Each correction is a new `implementation` run and append. The first corrective run records `rework-required`; that outcome remains sticky. Later runs omit time to first candidate because the original candidate already established it. |
| Separate review | A qualified independent review appends one `implementation-review` record. Its exact total projects to `Review tokens` and Own, never `Implementation tokens`. |
| No-persistence review | A reviewer whose exact attributable artifact is unavailable appends an unavailable `implementation-review` record, normally with `artifact-unavailable` or `unsupported-telemetry`; no counter or exact Project total is guessed. |
| Partial failure and retry | A confirmed append followed by a failed Project write keeps the ledger authoritative. Retry `--project --apply` only. An uncertain append retries the identical record/key; a duplicate is counted once. |

Review-driven code changes use a new `implementation` run. They never extend the already-finalized
`implementation-review` record.
