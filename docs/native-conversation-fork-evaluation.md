# Native conversation-fork qualification

This evaluation applies [ADR-039](adr/ADR-039-native-conversation-fork-resume.md) to native Codex
`/fork` and Claude Code `/branch`. The original evaluation asked whether the provider could keep
the preserved original A and native child B concurrently live. The extension below keeps those
findings and separately evaluates the broader outcome: exact independently writable branches may
be B/C when exact A/B preservation is unavailable. It makes no runtime change.

## Broader-outcome extension — 2026-09-01

The gate is **open for downstream runtime design**. One exact Codex condition qualifies through an
equivalent sibling: native `A → B`, then picker-free exact `codex fork A → C`. One exact Claude
condition qualifies through identity preservation: native `A → B`, then exact resume A. Both
conditions require direct physical-key gesture provenance from ghostty-web 0.4 and are limited to
the proved local macOS host condition. Paste, IME, editing/completion, unsupported terminal
engines, unproved provider versions, Linux, and SSH remain fail-closed conditions rather than
implicit support.

`Supported` means the complete evidence composition qualifies for the exact provider, artifact,
terminal-engine, input-origin, and host condition. Unsupported results use the four reasons already
owned by evaluated results:

- `transition-kind-unqualified`: the condition cannot prove one exact submitted native fork action.
- `current-terminal-unqualified`: the provider result cannot be bound to one exact current hvir PTY
  generation.
- `concurrent-resume-unavailable`: the preserved original cannot be resumed while the native fork
  remains live; this still closes the narrow A/B route but not an equivalent B/C route.
- `host-unqualified`: the claimed host lacks equivalent exact source or lifecycle evidence.

### Qualification matrix

| Provider condition | Intent evidence | Provider identity and ancestry | PTY association and sibling path | Result |
| --- | --- | --- | --- | --- |
| Codex CLI 0.151.0, default local artifact, ghostty-web 0.4, direct physical typing, macOS | A constant-state matcher can require direct-key `/fork` plus direct Enter after a clean input boundary; it never reads cells or output | B's first complete `session_meta` names B, parent A, one ordinal cutoff, and one complete parent byte boundary; exact `codex fork A` creates C with the same relationship and boundary | The current A, admitted PTY generation, child creation after admission, root Codex process ownership of B, and exactly one matching B compose without proximity selection; the sibling launches picker-free as exact C | **Supported:** equivalent B/C branches |
| Codex CLI 0.151.0, exact configured artifact root, same engine/input/host | Same exact gesture condition | The prior custom-root proof retained exact metadata and root resolution; placement does not change the fork or exact command semantics | Qualification is scoped to the launch's exact configured root and the same process-owned candidate rule | **Supported:** equivalent B/C branches |
| Codex CLI 0.151.0, paste, IME, edited/completed command, repeated submission, or unknown input origin | The matcher rejects the condition and forwards input unchanged | Provider metadata may still describe a real fork, but cannot retroactively supply user-intent provenance | No observation window is armed, so no sibling is created | **Unsupported:** `transition-kind-unqualified` |
| Codex CLI 0.151.0 with an engine lacking exact direct-key provenance | Raw PTY bytes cannot distinguish direct typing from paste or composition | Exact metadata remains identity-only evidence | Artifact or process proximity cannot replace the missing gesture | **Unsupported:** `transition-kind-unqualified` |
| Codex CLI 0.151.0, local Linux | The direct-key and provider contracts are host-independent | `/proc/<pid>/fd` is a bounded candidate association mechanism, but no real Linux lifecycle proof was available | No Linux support claim is made until exact PID/file ownership and cleanup run in that host condition | **Unsupported:** `host-unqualified` |
| Codex CLI 0.151.0, SSH | Direct-key intent can remain scoped to the remote PTY generation | The remote artifact could be parsed through `ProjectHost` | `SshHost` exposes a synthetic PTY PID, not an exact remote provider PID; a same-parent external fork therefore cannot be excluded | **Unsupported:** `current-terminal-unqualified`, `host-unqualified` |
| Claude Code 2.1.251, default local artifact, ghostty-web 0.4, direct physical typing, macOS | The same bounded matcher can qualify exact direct-key `/branch` plus Enter | The provider's launch-scoped status line supplies exact current identity B and transcript path after the documented branch action; exact resume A and the prior live proof establish shared history and independent writes | A unique per-PTY status sink binds the one identity change to the current PTY; exact resume A opens without a picker | **Supported:** identity-preserving A/B branches |
| Claude Code 2.1.251, exact `CLAUDE_CONFIG_DIR`, same engine/input/host | Same exact gesture condition | The prior custom-root proof retained exact status identity and transcript resolution | The launch-scoped sink and cleanup stay inside the exact configured root | **Supported:** identity-preserving A/B branches |
| Claude Code 2.1.251, paste/edit/IME or unsupported engine | No exact direct-key gesture is admitted | A status identity change alone does not prove `/branch` | No observation window is armed | **Unsupported:** `transition-kind-unqualified` |
| Claude Code 2.1.251, SSH | The matcher is host-independent | A remote launch-scoped status sink is feasible, but no real-host proof or accepted no-helper cleanup was available | Local success does not qualify remote lifecycle behavior | **Unsupported:** `host-unqualified` |

The matrix is exact-version evidence, not a semantic-version promise. A provider or terminal update
must requalify its private metadata, input ordering, native command, and cleanup contract before
support is advertised.

## Evidence ownership

### User intent: bounded ghostty-web direct-key contract

ghostty-web 0.4 exposes a raw `onKey` event before its key encoder and emits the corresponding
ordinary printable byte or Enter byte synchronously through `onData`. Paste, `beforeinput`, and
composition take separate paths. That permits `TerminalPane` to add only an engine-neutral input
origin to bytes already being forwarded; it need not expose key text, a provider name, or a
provider command. The main-owned provider performs the match at the PTY write boundary.

The qualified matcher retains only `blocked`, `ready`, at most seven provider-fixed progress
positions, and `armed`, plus the PTY generation, event sequence, and one deadline. It starts
blocked. A noncandidate Enter can establish the next clean boundary without arming. From `ready`,
exactly one direct-key byte per expected position followed by one direct-key Enter arms one
observation window. Any mismatched or multi-byte chunk, origin without a matching raw key,
editing/navigation key, paste shortcut, composition, second Enter while armed, new input while
armed, identity/lifetime change, or timeout revokes the candidate. The raw bytes continue to the
native PTY in every case.

| Input or engine condition | Observed engine behavior | Qualification |
| --- | --- | --- |
| Direct physical typing | `onKey` precedes one synchronous printable `onData`; unmodified Enter emits one carriage return | Supported after a clean boundary; no screen read is needed |
| Clipboard paste or programmatic paste | Clipboard/`beforeinput` emits paste data without one matching raw-key event per byte; bracketed paste may add more bytes | Rejected as a whole; pasted command text is never retained |
| IME/composition/mobile input | Composition and `beforeinput` can emit data without the direct-key sequence | Rejected |
| Backspace, Delete, arrows, Tab, history, or completion | The key is observable but does not advance the fixed command | Current candidate is discarded; the following Enter only restores `ready` |
| Repeated Enter or later input | A second submission can race provider persistence | Revokes an unconsumed window; consumed authority can never produce a second action |
| Alternate screen | Printable and unmodified Enter encoding remains on the same input path; screen cells are not consulted | Supported for the evaluated native TUIs |
| Active cells and retained ranges | They can expose composer or transcript presentation | Rejected even when extraction is bounded |
| Pane replacement, reconnect, PTY restart, or engine replacement | Input provenance or generation continuity changes | Pending state is revoked; an engine without the same contract is unsupported |
| Unsupported provider or terminal version | Command bytes, metadata, or event ordering may change | No matcher is installed |

This is not a general slash-command parser. Nonmatching bytes are compared and forgotten at the
already-authoritative transport boundary; no command, composer text, terminal output, retained
range, or screen content is emitted, logged, or persisted. `TerminalPane` remains provider-blind,
and returning `false` from the raw-key observer preserves ghostty-web's native handling.

### Codex provider identity and ancestry

The [Codex developer command documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
defines `/fork` as cloning the current conversation into a new conversation ID and documents exact
resume and fork commands by ID. For 0.151.0 the provider-private bounded parser accepts only a first
complete `session_meta` record with all of these consistent facts:

- the record's child `id` is present and differs from A;
- `forked_from_id` equals exact current A;
- `forked_from_ordinal_exclusive` is a bounded integer;
- `history_base.thread_id` equals A;
- `history_base.end_ordinal_exclusive` equals `forked_from_ordinal_exclusive`;
- `history_base.end_byte_offset` is positive, inside the configured cap and existing parent file;
  and
- the byte immediately before that offset terminates one complete parent JSONL record.

The parser reads one bounded child metadata prefix and one boundary byte. It does not read, copy,
hash, compare, or materialize inherited transcript bodies. The field names and shapes remain
private to the exact provider version and are not shared hvir vocabulary.

A content-free live proof established native `A → B`, then launched exact positional
`codex fork A` while B remained live. The command created exactly one C without a picker even
though the B process retained the writer-owned A rollout. B and C both named A, carried the same
ordinal and byte boundary, and remained live. A stayed unchanged during a B-only turn; only B
grew. A and B stayed unchanged during a C-only turn; only C grew. The source recovery identity is
B and the sibling recovery identity is C. Missing A, malformed or incomplete metadata, more than
one qualifying candidate, command rejection, or a child whose boundary differs is a visible
failure; the implementation must never fall back to `--last`, a picker, or a fresh session.

### Codex PTY association

The previous process proof showed that hvir's launch shell `exec`s Codex and the exact root process
owns A before the fork, then owns both A and B after the fork. Process ownership alone therefore
does not say which thread the TUI displays. In the broader composition it has a narrower role: an
admitted exact `/fork` supplies intent, `B.forked_from_id=A` supplies ancestry, and the source PTY's
exact descendant process owning newly created B excludes an external process's same-parent fork.
Exactly one candidate may qualify; simultaneous or competing same-parent forks fail closed.

The macOS live proof used OS open-file evidence to establish feasibility. A runtime must not shell
out to ambient `lsof`; the narrow process-owned-file query belongs behind a host adapter using a
stable OS facility. Linux has an analogous bounded `/proc/<pid>/fd` route but remains unclaimed
until a real-host proof passes. SSH remains unsupported because the current host contract has no
exact remote process identity.

## Current Codex lifecycle hooks

Current Codex lifecycle hooks were tested separately from legacy `notify`. Invocation-only
`SessionStart` and `SessionEnd` command hooks can be supplied with CLI configuration and
`--dangerously-bypass-hook-trust`, so the proof changed no persistent user configuration. The
content-free `SessionStart` input contains `hook_event_name`, `session_id`, `transcript_path`,
`cwd`, `model`, `permission_mode`, and `source`.

They do not provide the transition boundary. The live transition produced no new start or end
hook at fork commit. Static 0.151.0 source has only `startup`, `resume`, `clear`, and `compact`
start sources and maps forked initial history to `startup`; the child start hook is deferred until
its first turn. `SessionEnd` uses the generic reason `other`. The source, parent identity, and
fork boundary are therefore missing even when a later child start supplies exact B. The temporary
hook command, sink, synthetic workspace, and provider sessions were removed with the proof.

Legacy `notify` remains a separate, rejected signal: it has no fork event, arrives only after a
later completed turn, and its provider payload contains input messages and the last assistant
message before any hvir-owned filter can reduce it.

## Claude `/branch` extension

The [Claude Code session documentation](https://code.claude.com/docs/en/sessions) defines
`/branch` as creating a new session from the current conversation while leaving the original
unchanged and documents exact resume by session ID. The prior 2.1.251 proof established that exact
resume A succeeds while B remains live and that later A-only and B-only messages stay in their
respective transcripts.

The documented [status line](https://code.claude.com/docs/en/statusline) is launch-scoped and
reports exact `session_id`, `transcript_path`, cwd, and version to a unique per-PTY sink. It does not
carry a branch kind or parent field, which is why the original evaluation rejected it alone. The
new direct-key contract supplies only the missing explicit `/branch` action; the provider status
still owns exact B. Exactly one A-to-B status identity transition after the admitted gesture binds
the documented branch result to that PTY, while exact resume A provides the sibling. No transcript
body or `local_command` text is inspected.

Claude hooks still provide no branch event, and a status identity change without the admitted
gesture remains `transition-kind-unqualified`. The proof used launch-scoped inline settings, did
not persist hooks or settings, and removed the temporary status sink and synthetic project state.

## Original narrow-result preservation

The earlier A/B-only gate remains closed for Codex. With native B still live, exact
`codex resume A` in a second PTY exits unsuccessfully before completing a turn or owning A's
rollout. B remains writable and A unchanged. Artifact placement does not change that active-writer
contract. The result remains `concurrent-resume-unavailable`; the broader result succeeds only
because exact `codex fork A` can read the writer-claimed parent and produce equivalent C.

The earlier passive candidates also retain their original limits:

| Candidate | Preserved finding | Role in the extended composition |
| --- | --- | --- |
| Artifact creation | Exact B and parent A, but no PTY provenance | Provider identity/ancestry only |
| Root PID open-file ownership | One process owns A and B, so it is not current-display state | Supporting PTY association only after exact intent is admitted |
| Lifecycle/legacy notifications | No content-free fork-kind boundary | Not used |
| Launch arguments, environment, title, cwd, time, or recency | Do not change with the displayed conversation or are proximity evidence | Rejection predicates only |
| Privileged OS audit | Platform-specific and still observes low-level operations | Not required; the narrow owned-process file query is sufficient locally |

The prior Claude finding is also preserved: the status line alone identifies a transition but not
its kind, while exact concurrent resume and independent transcript ownership already qualify. The
bounded gesture supplies the missing kind only for the direct-key condition.

Codex App Server and `codex --remote` remain rejected. They would replace the accepted native TUI
topology and add transport, authentication, reconnection, and cleanup lifecycles. No route in this
evaluation depends on them.

## Concurrency, replay, and bounded cost

Admission captures exact A, host-qualified workspace and cwd, provider/profile and launch
revision, PTY instance and generation, descendant process identity or unique status sink, and one
monotonic input sequence. The provider observer then considers only candidates created after that
sequence. An external fork, simultaneous fork, same-workspace session, or internal provider child
cannot cross-correlate: wrong process/status source, wrong parent, provider child classification,
more than one candidate, or a different boundary rejects the whole window. Sequential native
forks are new gestures with new generations and authority; an old event cannot consume them.

The target algorithm reuses Codex session discovery, Claude artifact resolution, and the
host-multiplexed telemetry owner where their existing semantics fit. One PTY owns at most one
matcher and one armed window. The evaluated bound is four newly created candidates, one 256 KiB
metadata prefix per candidate, one 2 MiB maximum parent boundary with a one-byte completion check,
32 queued filesystem/status events, two read/stat retries per candidate, and one timer. Exceeding
any cap fails closed. Local cost is constant in store size. An eventual SSH implementation would
use the same candidate and operation caps through `ProjectHost`, never reconnect or prompt solely
for observation, and install no remote helper; no current SSH condition qualifies.

The source observer is relocated only after exact B is accepted: abort and dispose A's subscription,
install exact B and its recovery identity, and reject late A-generation records. Starting C uses
ordinary provider/profile composition through the PTY supervisor; C must independently qualify its
exact recovery identity and ancestry. PTY exit, terminal deletion, pane replacement, provider or
profile change, host disconnect, or launch revision change revokes input state, candidate reads,
timers, status sinks, and sibling authority. Reconnect never replays it.

## Controlled restart and upstream signals

Controlled restart is not needed for either supported local route and remains evaluation-only.
Automatic teardown would need separate user confirmation, proof of no in-flight turn, and lossless
input, output, artifact, and terminal-state transfer. Those facts are not available, so this issue
authorizes no termination or restart.

Codex 0.151.0 emits configurable OSC terminal titles but no narrow committed-fork or session-
transition OSC. The evaluated Claude version likewise exposes no provider-native terminal event
that closes this gap. A future provider event could replace intent/association evidence after a
new version qualification; its current absence is a completed condition, not pending work.

## Downstream runtime boundary

The supported result permits the epic coordinator to scope runtime work, but this evaluation does
not create it. The exact owners are:

- ghostty-web adapter and `TerminalPane`: engine-neutral direct-key versus non-key input origin,
  with no provider match or text publication;
- main-owned Codex and Claude providers: constant-state gesture matchers, version gates, exact
  provider metadata/status parsing, and exact resume/fork launch profiles;
- PTY supervisor: one generation-bound authority, candidate-window lifecycle, atomic source
  recovery/observer relocation, and one sibling start request;
- `ProjectHost`: bounded candidate observation and exact local process-owned-file association; and
- the existing terminal workspace owner: adjacent placement through ordinary terminal creation.

The first implementation must retain the local macOS/version/engine limits above. Linux and SSH
support require their own exact host proofs. No settings, general command framework, conversation
graph, App Server transport, daemon, persistent provider configuration, automatic teardown, or
prompt delivery belongs in that scope.

## Evidence boundary

The extension combined official provider documentation, bounded source and artifact inspection,
existing hvir provider/observer seams, and disposable content-free live proofs on macOS arm64
through 2026-09-01. Proof output contained only booleans, field-presence checks, provider versions,
bounded sizes/counts, and lifecycle outcomes. It did not print or retain provider IDs, paths,
prompts, responses, reasoning, transcript bodies, terminal input/output, credentials, account
facts, environment values, or raw provider records.

All synthetic Codex sessions were deleted through exact provider cleanup. Synthetic Claude state,
temporary hook/status sinks, invocation-only configuration, workspaces, and proof processes were
removed. No daemon, remote service, installed helper, or persistent provider configuration was
created.
