# Live harness usage proof

This procedure verifies that a live supported Codex or Claude Code session can produce two
content-free cumulative snapshots and a truthful phase delta through the bundled harness
provider boundary. It is contributor acceptance evidence, not an application feature or a
generic transcript reader.

The provider owns exact artifact location, session qualification, record selection, duplicate
handling, model and effort interpretation, and native counter normalization. The proof command
supplies the provider with an exact session identity and launch working directory, but neither
value appears in its output. Central delta policy receives only the normalized snapshot.

## Procedure

Run the proof from the same local host as the live harness. Set these values without printing
them:

```sh
export HVIR_USAGE_SESSION_ID='<exact current session id>'
export HVIR_USAGE_CWD='<exact launch working directory>'
```

For Codex, `CODEX_THREAD_ID` supplies the current exact identity. For a Claude Code proof, launch
or resume a session with an explicitly preassigned `--session-id` and retain that value privately.
When a non-default artifact root is active, retain `CODEX_HOME` or `CLAUDE_CONFIG_DIR` in the
environment; the provider interprets it.

Capture the bounded start snapshot, allow at least one real model turn in that exact session, and
calculate the end delta:

```sh
private_start_snapshot="$(mktemp)"
trap 'rm -f -- "$private_start_snapshot"' EXIT
npm run --silent proof:harness-usage -- snapshot codex > "$private_start_snapshot"
# Perform one real turn in the exact session.
npm run --silent proof:harness-usage -- delta codex < "$private_start_snapshot"
```

Use `claude-code` instead of `codex` for Claude Code. The temporary start file contains only the
whitelisted snapshot schema, but it should still be removed after the proof. The command exits 2
for an unavailable snapshot or delta and emits only fixed reason codes. Codex rollout histories
are scanned incrementally with a bounded individual-record size, so the history may grow without
a whole-file memory limit. Oversized records invalidate older counters until a later valid
cumulative record restores them. Claude artifacts larger than the 8 MiB read bound remain
explicitly unavailable rather than partially parsed.

## Observed result

The procedure was exercised on 2026-08-16 with Codex CLI 0.147.0 and Claude Code 2.1.228 through
`LocalHost`:

| Provider | Result | Preserved route | Non-negative observed delta |
| --- | --- | --- | --- |
| Codex | Complete | `gpt-5.6-sol`, effort `high` | fresh input 2,756; cache read 396,544; cache write 0; output 678; reasoning 64; normalized total 399,978 |
| Claude Code | Complete | `claude-opus-5`, effort `high` | fresh input 2; cache read 14,315; cache write 105; output 4; normalized total 14,426; reasoning absent |

Both results increased from the provider-qualified start snapshot without a reset. Their JSON
contained no session identifier, artifact path, launch directory, request/message identifier,
prompt, response, transcript, terminal, code, environment, credential, rate-limit, or account
content. Claude Code's missing reasoning counter remained absent and was not replaced by zero.
Neither artifact exposed cumulative model/API time, so that timing value also remained absent.

Deterministic adapter tests retain the same `ProjectHost` contract for local and SSH transports
and cover malformed records, exact identity, missing artifacts, duplicate Claude records,
counter movement, missing counters, and reset rejection without requiring ambient provider data.

## Lifecycle checkpoint contract

Repository lifecycle skills use the same provider boundary through a private checkpoint that
survives stateless tool shells and conversation compaction:

```sh
npm run --silent agent-work:checkpoint -- start \
  --issue <positive-number|pending> --phase <phase> --provider <codex|claude-code> \
  --run-key <canonical-64-hex-run-key>
npm run --silent agent-work:checkpoint -- finish \
  --issue <positive-number|pending> --phase <phase> --provider <codex|claude-code> \
  --run-key <canonical-64-hex-run-key>
```

Use `--issue pending` only for an authorized `issue-planning` run before GitHub assigns the new
issue number. The same pending discriminator must qualify that run's start, pause, resume, finish,
abandon, and release operations. Every other phase requires the real positive issue number. The
pending discriminator is private checkpoint identity; it never replaces the real issue number in
a ledger record or Project operation and never appears in command output.

Codex resolves the exact current `CODEX_THREAD_ID` directly. Claude Code requires its explicitly
preassigned current identity in `HVIR_USAGE_SESSION_ID`. Start defaults the qualified launch
directory to its current working directory; `HVIR_USAGE_CWD` is the private override when those
are different. The checkpoint retains the launch context, provider artifact environment,
content-free baseline, and monotonic active-time accumulator in a mode-`0700` private temporary
root with mode-`0600` files. Each active segment retains a bounded epoch sample bracketed by
monotonic readings. A delayed sample is retried, and another CLI process accepts the duration only
when the bounded monotonic interval and epoch delta agree within a 1,000-parts-per-million relative
rate bound. That conservative bound is twice [NTPv4's 500-ppm maximum clock-discipline frequency
tolerance](https://www.rfc-editor.org/rfc/rfc5905.html#appendix-A.5.5.6); sample uncertainty and
epoch millisecond quantization are accounted for separately.
Legacy state, an unbounded sample, a backwards clock, or a rate/jump disagreement omits active time
instead of guessing. Its location and private contents never appear in command output.

The canonical 64-hex run key isolates sequential or overlapping runs inside one supported session
and never appears in checkpoint output. `pause` and `resume` exclude an explicit maintainer wait
from active time. `abandon` removes an unfinished checkpoint. Start is idempotent and preserves the
first baseline. Finish atomically retains a content-free observation and returns it unchanged on a
retry without another provider read. `release` removes that finalized observation only after the
ledger append is confirmed or reported as an identical duplicate. Another delegated or resumed
identity, or another run key, cannot locate the checkpoint and receives the fixed
`run-identity-unproven` result. Operational failures remain retryable. The owner prunes only its
recognized open or finalized files after 30 days; per-entry cleanup races are best-effort and
never replace the requested checkpoint operation's own validation.
