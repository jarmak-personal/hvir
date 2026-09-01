# Native conversation-fork qualification

This evaluation applies [ADR-039](adr/ADR-039-native-conversation-fork-resume.md) to the current
native Codex `/fork` and Claude Code `/branch` behaviors. It records volatile provider evidence
outside the durable decision and makes no runtime change.

## Gate result

The gate is **closed**. Neither evaluated provider condition supplies both an exact, content-free
fork transition for one current hvir terminal and concurrent exact resume of the preserved
original. Issue #694 therefore returns for product alignment or future provider evolution; this
evaluation enables no downstream runtime child.

`Supported` means that both requirements qualify for the exact provider version, artifact
configuration, and host condition. Unsupported results use these fixed reasons:

- `transition-kind-unqualified`: the source cannot distinguish a committed native fork from other
  conversation transitions without inspecting command or terminal content.
- `current-terminal-unqualified`: provider-owned evidence cannot be correlated to one current
  hvir PTY and launch lifetime without an ambient or proximity inference.
- `concurrent-resume-unavailable`: the exact preserved conversation cannot be resumed while the
  fork remains live.
- `artifact-unavailable`: the exact committed fork artifact cannot be found and qualified.
- `host-unqualified`: the claimed host condition lacks equivalent exact source or lifecycle
  evidence.
- `version-unqualified`: the provider version does not expose the required source semantics.
- `stale-generation`: evidence does not distinguish the current PTY/observer generation from
  replay, duplication, or late delivery.
- `resource-unavailable`: the observation resource cannot be bounded and revoked with its owner.

The first three reasons are decisive in this evaluation. The remaining vocabulary fixes how a
future provider condition must fail closed rather than imply partial support.

## Qualification matrix

| Provider condition | Exact current transition | Concurrent exact resume | Artifact and observation | Result |
| --- | --- | --- | --- | --- |
| Codex CLI 0.151.0, default local artifact | The committed fork artifact records exact parent and fork identities, but the artifact alone does not correlate the transition to one simultaneously active hvir PTY | The native TUI keeps an active-writer claim on the preserved original, so an exact concurrent resume is rejected | The complete fork `session_meta` is authoritative and the existing Codex observer can read its exact artifact after a qualified relocation | **Unsupported:** `concurrent-resume-unavailable`, `current-terminal-unqualified` |
| Codex CLI 0.151.0, custom artifact root, local | The provider metadata semantics remain exact once the artifact is known, but no launch-scoped current-PTY transition source was qualified | The provider's active-writer behavior is unchanged by artifact-root placement | hvir can resolve configured roots only after an exact identity and transition are known | **Unsupported:** `concurrent-resume-unavailable`, `current-terminal-unqualified` |
| Codex CLI 0.151.0, SSH | The same provider metadata exists remotely, but no real-host PTY correlation proof was available | The provider contract still rejects the required concurrent resume | An exact remote artifact would be readable through `ProjectHost`; that does not cure either decisive defect | **Unsupported:** `concurrent-resume-unavailable`, `host-unqualified` |
| Claude Code 2.1.251, default local artifact | A launch-scoped status line reports the exact current identity, transcript path, cwd, and version, but not whether an identity change was `/branch`; hooks emit no branch event | Exact resume succeeds while the fork is live, and post-fork messages remain in independent transcripts | The reported exact transcript is readable after the identity change, but the change lacks a qualifying fork discriminator | **Unsupported:** `transition-kind-unqualified` |
| Claude Code 2.1.251, custom `CLAUDE_CONFIG_DIR`, local | Launch-scoped status reporting and exact artifact resolution respect the configured root, but the transition remains semantically ambiguous | Concurrent resume and transcript independence qualify | The exact configured transcript can be observed only after an unqualified transition | **Unsupported:** `transition-kind-unqualified` |
| Claude Code 2.1.251, SSH | The status-line mechanism runs with the remote provider, but no real-host lifecycle proof was available and its payload still lacks fork kind | Provider semantics permit concurrent exact resume, but the full host condition is not qualified | A future sink would have to be bounded through `ProjectHost` and removed with the PTY; none was accepted here | **Unsupported:** `transition-kind-unqualified`, `host-unqualified` |

No custom artifact location changes either provider's decisive semantic result. A supported result
would still be scoped to an explicitly qualified location and launch revision rather than inferred
from provider defaults.

## Codex `/fork`

The [Codex developer command documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
defines `/fork` as cloning the current conversation into a new conversation ID while leaving the
original unchanged, and documents exact resume by ID. Static inspection and a disposable live
proof established that the fork's first complete `session_meta` record carries exact fork identity
and `forked_from_id`. That record is provider-owned persisted metadata already inside hvir's
accepted Codex artifact boundary; copied message history or file recency is not needed to establish
the static relationship.

That relationship does not qualify the feature. With the native fork TUI still live, exact resume
of the preserved original is rejected because that conversation has an active writer. The command
does not fall back to a picker or fresh conversation, but it cannot create the required independent
concurrent sibling. Sequential metadata can represent a chain of exact parent identities, yet no
runtime handling of repeated forks is enabled when the first preserved original cannot be resumed.

The artifact also does not by itself prove which one of multiple active hvir PTYs committed the
fork. A provider launch token or equivalent TUI protocol relation was not available through the
current native launch. Cwd, artifact recency, and timestamp correlation are prohibited, and hvir
will not add Codex App Server solely to observe the command. Codex is therefore unsupported even
apart from the active-writer failure.

## Claude Code `/branch`

The [Claude Code session documentation](https://code.claude.com/docs/en/sessions) defines
`/branch` as switching the current terminal to a new session while leaving the original unchanged,
and documents exact resume by session ID. A disposable live proof confirmed that the original can
be resumed while the branch remains live and that messages written after the branch stay exclusive
to their respective transcripts. Sequential branches, including a branch from a preserved
sibling, also retained independent exact session identities.

Claude's documented [status line](https://code.claude.com/docs/en/statusline) can be configured at
launch to report `session_id`, `transcript_path`, `cwd`, and version to a unique per-PTY sink. It
showed the current TUI's exact identity change and exact new transcript. However, the structured
payload contains no transition kind or parent-to-branch relationship. The new transcript carries
copied historical session identifiers and new current-session records, but no structured native
branch discriminator. Inspecting its `local_command` command text would be slash-command inference
and is prohibited.

The documented [Claude Code hooks](https://code.claude.com/docs/en/hooks) do not close the gap:
`SessionStart` covers startup, resume, clear, and compact sources, and no start or end event was
emitted for the in-place branch in the proof. An identity change alone could also represent an
unrelated native transition such as rewind. Per-PTY status sinks can prevent two terminals from
crossing their current identities, but they cannot prove which identity changes are forks.
Therefore concurrent resume succeeds while the exact transition requirement remains unsupported.

The proof used launch-scoped inline settings only. It did not persist hooks or settings, and it
removed the temporary sink and provider state after completion.

## Concurrency, replay, and observation relocation

Multiple sessions in one workspace and simultaneous forks make proximity correlation unsafe.
Claude's unique per-PTY status sink can identify which PTY changed identity, while Codex's
persisted parent relationship identifies what was forked after its artifact is found. Neither
current source provides the whole accepted relation. A future qualifying contract must carry a
launch token, PTY generation, monotonic event identity or sequence, exact original and fork
identities, and a committed transition boundary. Duplicate, replayed, out-of-order, oversized, or
late records must be rejected without consuming the one-action authority; a later valid fork must
remain independently eligible.

The existing host-multiplexed Codex and Claude observer hubs can dispose an exact-session
subscription and subscribe to a different exact artifact. The limiting current owner is the PTY
supervisor: `HarnessTelemetryContext` contains one immutable session identity and artifact, and the
supervisor starts telemetry once for the entry. A future supported implementation would need one
atomic, generation-aware transition of recovery identity and observation: qualify the new artifact,
abort and dispose the old observer, install the new exact identity, and reject late old-generation
records. For Codex the complete fork `session_meta` is the earliest authoritative artifact
boundary. For Claude the status line makes the exact transcript readable after the TUI transition,
but the transition cause remains unqualified.

Because neither provider passes the gate, this document does not authorize that supervisor or
observer work.

## Host, failure, and cleanup conditions

Local and SSH behavior must use the same provider-neutral result and operate through
`ProjectHost`. Observation may not reconnect, prompt for authentication, or leave a helper running
solely to outlive the owning terminal or host connection. PTY exit, host disconnect, launch
replacement, and terminal deletion revoke pending transition authority and observation resources.
Any missing source, unavailable artifact, rejected resume, observer relocation failure, or stale
generation must surface a bounded failure and must never select a recent session, open a picker, or
launch fresh.

No real SSH acceptance environment was available for this evaluation. The local failures are
provider-contract failures rather than local filesystem accidents, so SSH does not become a
supported fallback. A future provider version would require its own real-host qualification before
claiming SSH support.

## Evidence boundary

The evaluation combined current official provider documentation, bounded source and artifact
inspection, the existing hvir provider/observer seams, and content-free live proofs on macOS arm64
on 2026-08-31. Proofs used only disposable synthetic workspaces and conversations, with provider
tools disabled or sandboxed. Recorded output was limited to booleans, schema-key presence,
provider versions, and lifecycle outcomes; it did not print or retain real session identifiers,
paths, prompts, responses, reasoning, transcript bodies, terminal input or output, credentials,
account facts, or environment values.

All synthetic Codex sessions were deleted through exact provider cleanup. Synthetic Claude project
state was purged through exact provider cleanup. Temporary workspaces, status sinks, inline
settings, and proof processes were removed, and no daemon, remote service, or persistent provider
configuration was installed.
