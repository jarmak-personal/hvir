# Record lifecycle agent work

Use this procedure only for work authorized through a repository lifecycle skill. The canonical
vocabulary, schema, exclusions, and phase boundaries remain in
[`docs/agent-work-measurements.md`](../../../../docs/agent-work-measurements.md); the repository
commands remain documented in [`docs/project-management.md`](../../../../docs/project-management.md).
The provider-owned snapshot procedure and private inputs are documented in
[`docs/agent-work-usage-proof.md`](../../../../docs/agent-work-usage-proof.md).

Measurement is optional evidence. A missing snapshot, unavailable Project field, failed append,
or failed projection never relaxes or blocks the lifecycle's normal delivery gates. Report the
measurement failure and continue the authorized work.

## Open one run

At the phase's start observation:

1. Establish and privately retain the canonical content-free run and idempotency keys described
   in the measurement contract. Reuse the same idempotency key for any finalization retry.
2. Start a monotonic active-wall accumulator. Exclude only explicit suspension while awaiting
   maintainer input or acceptance; include tools, checks, pushes, and external model/API work.
3. Record the exact initial harness, model identifier, and requested/effective reasoning effort
   exposed by the selected runtime. Omit an unavailable fact rather than replacing it with a
   family name or inferred value.
4. Open the repository-owned private checkpoint before leaving the exact harness launch working
   directory. For Codex, the command qualifies the current `CODEX_THREAD_ID` directly. For Claude
   Code, supply the explicitly preassigned current session identity through
   `HVIR_USAGE_SESSION_ID` without printing it. Set `HVIR_USAGE_CWD` only when the command's current
   directory is not the exact harness launch directory. The command retains the private identity,
   launch context, provider artifact environment, content-free start snapshot, and monotonic active
   clock across stateless tool shells and compaction. Persisted epoch and monotonic anchors must
   agree across those processes; otherwise the final observation omits active time:

   ```sh
   npm run --silent agent-work:checkpoint -- start \
     --issue <number> --phase <phase> --provider <codex|claude-code> \
     --run-key <canonical-64-hex-run-key>
   ```

   Supply the same canonical run key established in step 1. A repeated start for the same exact
   issue, phase, provider, session, and run key is `unchanged`; it never replaces the first
   baseline. A distinct run key creates isolated state even inside the same harness session. An
   absent or different delegated identity fails closed with `run-identity-unproven` and cannot
   discover another session's checkpoint. The key may identify the bounded repository run, but it
   still stays out of checkpoint output. Do not print, publish, or put the session identity, launch
   directory, artifact location, checkpoint location, or checkpoint state in a record. If start is
   unavailable, retain its fixed reason and continue.
5. Immediately before an explicit suspension for maintainer input or acceptance, pause the active
   clock. Resume it when the authorized workflow continues. These operations are idempotent and use
   the same arguments as start:

   ```sh
   npm run --silent agent-work:checkpoint -- pause \
     --issue <number> --phase <phase> --provider <codex|claude-code> \
     --run-key <canonical-64-hex-run-key>
   npm run --silent agent-work:checkpoint -- resume \
     --issue <number> --phase <phase> --provider <codex|claude-code> \
     --run-key <canonical-64-hex-run-key>
   ```

Record every explicitly observed route change in order. Preserve the initial route, number
changes contiguously from one, and set `escalation` only when the caller or coordinator explicitly
selected a stronger route. Do not rank model names or infer escalation. A separately delegated
or resumed lifecycle execution is a new run, not a route change.

## Finalize once

At the phase's finalization observation selected by the owning lifecycle skill, after its complete
handoff facts are stable but before ledger bookkeeping:

1. Finish the checkpoint with the same issue, phase, provider, and exact current identity. The
   command loads only that identity's qualified start state, takes the provider-owned end snapshot,
   calculates the delta, stops the monotonic active clock, and atomically replaces the private
   baseline with that content-free finished observation. A repeated finish returns the identical
   observation without reading the provider again. It never searches for or combines a nearby,
   delegated, resumed, differently keyed, or cross-provider session. For implementation, a push
   establishes candidate identity; it does not finalize the run before diff audit, architecture
   and acceptance rechecks, pull-request update, and handoff preparation finish. Capture the
   content-free result privately for record construction:

   ```sh
   hvir_agent_work_observation="$(npm run --silent agent-work:checkpoint -- finish \
     --issue <number> --phase <phase> --provider <codex|claude-code> \
     --run-key <canonical-64-hex-run-key>)"
   ```

   A fixed unavailable result means no matching current-identity and run-key checkpoint exists; do
   not recover another checkpoint by scanning private state. An operational failure retains the
   open checkpoint for an exact retry. If the workflow is abandoned before finalization, invoke
   `abandon` with the same arguments; repeating it is safely unavailable. A finalized observation
   is not abandonable. The owner also prunes only its own open or finalized checkpoint files after
   the bounded 30-day retention interval. Per-entry cleanup races are best-effort and cannot replace
   the requested operation's own identity and security validation. No lifecycle relies on an
   `EXIT` trap.
2. Build one closed schema-v1 record from observed facts only. A complete record includes every
   additive counter and its exact safe-integer normalized total. A partial record includes an
   initial route, at least one usage or timing fact, fixed `missingFacts`, and no normalized total.
   An unavailable record includes one fixed `unavailableReason` and no route, usage, timing, or
   missing-fact claims. The issue, phase, run, and idempotency keys and an allowed implementation
   outcome may still be present. Build the record from `hvir_agent_work_observation` without
   printing that private copy, then run `unset hvir_agent_work_observation` before ledger
   bookkeeping.
3. Dry-run the append, inspect the normalized plan, then apply the freshly supplied same record:

   ```sh
   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_AGENT_WORK_RECORD="$agent_work_record" \
   npm run project:measure -- --issue <number> --append

   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_AGENT_WORK_RECORD="$agent_work_record" \
   npm run project:measure -- --issue <number> --append --apply
   ```

4. Only after the append is confirmed or reported as the identical duplicate, release the
   finalized private checkpoint with the same arguments. Never release it after only a dry run,
   failed append, or uncertain append result. A lost finish result remains recoverable until this
   boundary:

   ```sh
   npm run --silent agent-work:checkpoint -- release \
     --issue <number> --phase <phase> --provider <codex|claude-code> \
     --run-key <canonical-64-hex-run-key>
   ```

5. After release, dry-run and apply the separate Project projection. If projection fails after
   append, retry projection only; do not append again.
6. After the issue's named projection has a reportable outcome, dry-run and apply its separate
   Rollup reconciliation. This clears a stale Rollup from an ordinary issue or epic child, and
   calculates a root epic from its Own ledger plus every native direct child's current Own ledger:

   ```sh
   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_PROJECT_TOKEN="$(gh auth token)" \
   npm run project:measure -- --issue <number> --rollup

   HVIR_REPO_TOKEN="$(gh auth token)" \
   HVIR_PROJECT_TOKEN="$(gh auth token)" \
   npm run project:measure -- --issue <number> --rollup --apply
   ```

   When the issue has an exact native direct parent, repeat only this Rollup operation for that
   parent after the child operation. This reconciles the parent after child planning,
   implementation, review, correction, or reopened work without editing the child's comments or
   Project values. Do not guess a parent or recurse beyond the one native relationship.
7. Report `complete`, `partial`, `unavailable`, `duplicate`, or failed/uncertain append,
   projection, and applicable Rollup state in the lifecycle handoff. Never include the private
   snapshot or provider identity inputs.

The measurement contract owns run, correction, route-change, first-pass, supersession, and retry
policy. This procedure adds three workflow expectations: review-driven code changes start a new
`implementation` run; an isolated supported reviewer with truthful route plus active-wall facts
emits a partial review record rather than discarding those facts; and every ledger change
reconciles the owning issue plus its one exact native parent when present.
