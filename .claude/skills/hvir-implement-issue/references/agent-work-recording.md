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
4. When an exact current Codex or Claude Code session identity and launch directory are privately
   available, set `HVIR_USAGE_SESSION_ID` and `HVIR_USAGE_CWD` without printing them. Capture the
   start snapshot with `npm run proof:harness-usage -- snapshot <codex|claude-code>` in a private
   temporary file. Keep it private and remove it on every exit. Do not print, publish, or put the
   session identity, launch directory, artifact location, or snapshot path in a record. If exact
   identity cannot be proven, retain the applicable fixed unavailable reason and continue.

   ```sh
   export HVIR_USAGE_SESSION_ID='<private exact current session identity>'
   export HVIR_USAGE_CWD='<private exact harness launch directory>'
   hvir_agent_work_start_snapshot="$(mktemp "${TMPDIR:-/tmp}/hvir-agent-work-start.XXXXXX")" ||
     hvir_agent_work_start_snapshot=

   cleanup_hvir_agent_work_snapshot() {
     if [[ -n "${hvir_agent_work_start_snapshot:-}" ]]; then
       rm -f -- "$hvir_agent_work_start_snapshot"
     fi
     unset hvir_agent_work_start_snapshot HVIR_USAGE_SESSION_ID HVIR_USAGE_CWD
   }
   trap 'cleanup_hvir_agent_work_snapshot' EXIT
   trap 'cleanup_hvir_agent_work_snapshot; exit 130' HUP INT TERM

   if [[ -z "${HVIR_USAGE_SESSION_ID:-}" || -z "${HVIR_USAGE_CWD:-}" ||
     -z "${hvir_agent_work_start_snapshot:-}" ||
     ! -f "$hvir_agent_work_start_snapshot" ]]; then
     cleanup_hvir_agent_work_snapshot
     trap - EXIT HUP INT TERM
     # Retain the applicable fixed unavailable reason and continue the workflow.
   elif ! npm run proof:harness-usage -- snapshot codex > "$hvir_agent_work_start_snapshot"; then
     cleanup_hvir_agent_work_snapshot
     trap - EXIT HUP INT TERM
     # Retain the applicable fixed unavailable reason and continue the workflow.
   fi
   ```

   Substitute `claude-code` for `codex` only for an exact Claude Code session.

Record every explicitly observed route change in order. Preserve the initial route, number
changes contiguously from one, and set `escalation` only when the caller or coordinator explicitly
selected a stronger route. Do not rank model names or infer escalation. A separately delegated
or resumed lifecycle execution is a new run, not a route change.

## Finalize once

At the phase's finalization observation selected by the owning lifecycle skill, after its complete
handoff facts are stable but before ledger bookkeeping:

1. Stop the active-wall accumulator and, when the qualified start snapshot exists, take the end
   snapshot for the same private inputs and calculate the delta with
   `npm run proof:harness-usage -- delta <codex|claude-code> < <start-snapshot>`. Never combine
   nearby or cross-provider sessions. For implementation, a push establishes candidate identity;
   it does not finalize the run before diff audit, architecture and acceptance rechecks,
   pull-request update, and handoff preparation finish. Capture the command's stdout privately for
   the record, then remove the snapshot and unset its private inputs before ledger bookkeeping:

   ```sh
   if [[ -n "${hvir_agent_work_start_snapshot:-}" &&
     -f "$hvir_agent_work_start_snapshot" ]]; then
     if ! hvir_agent_work_delta="$(
       npm run proof:harness-usage -- delta codex < "$hvir_agent_work_start_snapshot"
     )"; then
       unset hvir_agent_work_delta
       # Retain the applicable fixed unavailable reason and continue the workflow.
     fi
   fi
   cleanup_hvir_agent_work_snapshot
   trap - EXIT HUP INT TERM
   ```

   Use the same cleanup plus `trap - EXIT HUP INT TERM` on every abandonment path before
   finalization. Substitute `claude-code` for `codex` only when it was also used for the start
   snapshot.
2. Build one closed schema-v1 record from observed facts only. A complete record includes every
   additive counter and its exact safe-integer normalized total. A partial record includes an
   initial route, at least one usage or timing fact, fixed `missingFacts`, and no normalized total.
   An unavailable record includes one fixed `unavailableReason` and no route, usage, timing, or
   missing-fact claims. The issue, phase, run, and idempotency keys and an allowed implementation
   outcome may still be present. Build the record from `hvir_agent_work_delta` without printing
   that private copy, then run `unset hvir_agent_work_delta` before ledger bookkeeping.
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

The measurement contract owns run, correction, route-change, first-pass, supersession, and retry
policy. This procedure adds only two workflow expectations: review-driven code changes start a new
`implementation` run, and an isolated supported reviewer with truthful route plus active-wall
facts emits a partial review record rather than discarding those facts.
