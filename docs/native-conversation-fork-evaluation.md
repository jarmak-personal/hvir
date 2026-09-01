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
- `host-unqualified`: the claimed host condition lacks equivalent exact source or lifecycle
  evidence.

## Qualification matrix

| Provider condition | Exact current transition | Concurrent exact resume | Artifact and observation | Result |
| --- | --- | --- | --- | --- |
| Codex CLI 0.151.0, default local artifact | The committed fork artifact records exact parent and fork identities, but passive process ownership is not current-terminal-unique: the native TUI process retains open rollout handles for both A and B after switching to B | Exact `codex resume A` in a second PTY exits unsuccessfully while the first native TUI remains live on B | The complete fork `session_meta` is authoritative; filesystem creation has no PTY provenance, process ownership is multi-thread, and legacy notify is content-bearing and turn-delayed | **Unsupported:** `concurrent-resume-unavailable`, `current-terminal-unqualified` |
| Codex CLI 0.151.0, custom artifact root, local | Exact metadata and process ownership retain the same multi-thread current-PTY ambiguity at a configured root | The provider's active-writer behavior is unchanged by artifact-root placement | hvir can resolve configured roots, but placement does not add an exact committed transition source | **Unsupported:** `concurrent-resume-unavailable`, `current-terminal-unqualified` |
| Codex CLI 0.151.0, SSH | The provider has the same host-independent current-PTY contract defect as local: artifact creation lacks PTY provenance and provider process ownership is broader than the current displayed thread | The provider contract still rejects the required concurrent resume | An exact remote artifact would be readable through `ProjectHost`; the SSH PTY exposes no real remote PID for process correlation, and no real-host lifecycle proof was available | **Unsupported:** `concurrent-resume-unavailable`, `current-terminal-unqualified`, `host-unqualified` |
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

That relationship does not qualify the feature. With the native fork TUI still live on B, a
second native PTY running exact `codex resume A` exits unsuccessfully before completing a turn or
owning A's rollout. The original PTY remains live on B and can append a B-only post-fork message;
A remains unchanged. This re-test confirms exact post-fork transcript ownership where a write is
possible, but the active-writer rejection prevents the required two-writer independence. The
command does not fall back to a picker or fresh conversation. Sequential metadata can represent a
chain of exact parent identities, yet no runtime handling of repeated forks is enabled when the
first preserved original cannot be resumed.

The artifact also does not by itself prove which one of multiple active hvir PTYs committed the
fork. The following passive, PTY-scoped candidates were exhausted for 0.151.0:

| Candidate | Evidence | Failure boundary |
| --- | --- | --- |
| Artifact creation or change notification | B's first complete `session_meta` gives exact B and `forked_from_id: A` | The filesystem event has no provider-owned PTY provenance. Cwd, creation order, recency, and timestamp proximity cannot supply it. |
| Root Codex PID open-file ownership | hvir's local launch shell `exec`s Codex, and the exact native process owns A before the fork | After `/fork`, that same process owns rollout handles for both A and B while the displayed TUI is on B. Codex can own multiple internal threads, so process ownership is not current-terminal state. Descendant and writer-lock inspection cannot narrow a relation already owned by the root process. |
| Legacy `notify` | A later completed turn can report exact B | `/fork` has no dedicated notify event. The callback is an `AfterAgent` hook, arrives only after another turn, and its provider payload contains input messages and the last assistant message before any hvir-owned filter could reduce it. It is neither a content-free transition boundary nor fork-kind evidence. |
| Launch arguments, environment, process lifecycle, and terminal title | They remain scoped to the exact PTY lifetime | They do not change with the displayed conversation, and title or terminal-stream inspection would be presentation inference rather than provider authority. |
| Privileged OS audit or filesystem provenance | It could attribute low-level file operations to a process on selected local systems | It still observes artifact creation rather than which internally owned thread the TUI displays, is not available through the current local/SSH `ProjectHost` contract, and would add a privileged platform-specific lifecycle. |

The static artifact plus a process snapshot therefore cannot manufacture a committed A-to-B
current-terminal event: it would conflate the displayed thread with any internal thread the native
Codex process owns. A provider launch token or equivalent native TUI protocol relation was not
available through the current launch. hvir will not consume terminal input/output, add a separately
managed Codex App Server, or route the native TUI through `codex --remote` solely to observe this
command; either protocol route would enlarge transport, authentication, failure, and cleanup
lifecycles and replace the accepted native-launch topology. Codex is therefore unsupported even
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
through 2026-09-01. Proofs used only disposable synthetic workspaces and conversations, with provider
tools disabled or sandboxed. Recorded output was limited to booleans, schema-key presence,
provider versions, and lifecycle outcomes; it did not print or retain real session identifiers,
paths, prompts, responses, reasoning, transcript bodies, terminal input or output, credentials,
account facts, or environment values.

All synthetic Codex sessions were deleted through exact provider cleanup. Synthetic Claude project
state was purged through exact provider cleanup. Temporary workspaces, status sinks, inline
settings, and proof processes were removed, and no daemon, remote service, or persistent provider
configuration was installed.
