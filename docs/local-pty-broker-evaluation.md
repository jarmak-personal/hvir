# Demand-started local PTY broker evaluation

**Issue:** #215, child of survivability epic #58

**Evaluation date:** 2026-07-22

**Host:** macOS 15.7.3 (24G419), Apple M2, arm64

**Runtime:** Electron 43.2.0, embedded Node 24.18.0

## Recommendation

**Revise; do not adopt this broker shape in production yet.**

The experiment proved the central value proposition on one supported local host:

- a detached broker kept a synthetic PTY plus real Codex and Claude Code turns alive
  after their first client disconnected;
- a second client reattached to the same PTY PID with a new attachment epoch;
- explicit termination and lease expiry reaped the synthetic leader and its grandchild;
- bounded replay remained interactive after truncation; and
- measured input and resize latency stayed sub-millisecond in the sampled run.

Two blockers prevent production adoption:

1. Killing the broker itself closed the PTY leader but left a synthetic non-terminal
   grandchild alive in the broker-created process group. The test harness removed that
   exact group afterward, but a crashed production broker would no longer exist to do so.
2. Reusing Electron as a Node-compatible broker host solves the existing `node-pty` ABI
   problem but measured roughly 87 MiB baseline RSS for the extra process. That conflicts
   with hvir's lightweight experience unless a smaller runtime or materially different
   ownership design proves better.

No production terminal, IPC, renderer, provider, `ProjectHost`, startup, recovery, or
packaging path uses the prototype.

## Boundary tested

The executable spike tests an out-of-process local owner, not an integrated hvir feature:

```text
evaluation client → versioned Unix-socket protocol → detached broker → node-pty → harness
```

The broker receives an already-resolved executable, argv, cwd, environment delta, terminal
size, and lease. It has no provider, profile, workspace, renderer, durable-recovery, or UI
knowledge.

The successful continuity test corresponds to an Electron-main analogue disappearing
without cleanup while the broker remains alive. It does not yet establish:

- production Electron-main integration or crash reconciliation;
- packaged, signed, updated, or uninstalled application behavior;
- renderer-only reattachment through current hvir resource scopes;
- SSH transport loss or a remote attachable wrapper;
- host logout, reboot, sleep-boundary lease behavior, or power loss; or
- Linux real-harness, performance, lease, and packaging behavior beyond the automated
  synthetic lifecycle suite.

ADR-006 and ADR-010 remain unchanged.

## Prototype ownership and protocol

The prototype starts one detached, user-scoped broker on demand. Its bootstrap directory is
created with mode `0700`, the bootstrap file with `0600`, and the Unix socket with `0600`.
The broker reads and removes the bootstrap file before accepting requests. The directory
and socket are removed when it owns no sessions or bounded tombstones.

Protocol version 1 provides `status`, `list`, `spawn`, `attach`, `detach`, `write`,
`resize`, and `terminate`. Every request requires a random broker capability. Each session
also has a random capability, and each successful attachment rotates a separate capability
and increments its epoch. Old connection, epoch, or attachment-capability combinations
cannot write, resize, detach, or terminate the newly attached session.

The broker retains terminal data only in memory:

- default capacity: 16 client connections and 64 live/tombstoned sessions;
- default replay cap: 64 KiB per session;
- default global replay cap: 256 KiB;
- default client writable-queue cap: 128 KiB; and
- overflow behavior: discard PTY data before extending the user-space socket queue, then
  report a content-free overflow event when delivery resumes.

The tests use smaller limits to force replay truncation. Per-session/global replay and
client-queue decisions have deterministic policy tests. The real socket saturation path
did not produce a stable forced-overflow test on macOS because kernel socket buffering
absorbed the bounded fixture; production work needs a deterministic transport-level
backpressure test rather than treating the policy test as sufficient.

No request, terminal output, prompt, transcript, resolved environment, or credential is
logged or written by the broker. Synthetic tests write only a completion marker and
leader/grandchild PIDs into caller-owned temporary directories, then remove them.

## Crash and lifecycle results

| Case | Result | Evidence |
| --- | --- | --- |
| Client disappears while synthetic work is live | Pass | Marker was written after disconnect; second client attached to the same PTY PID. |
| Stale attachment after reattach | Pass | Old write, resize, and terminate authority was rejected as `STALE_ATTACHMENT`, and the old client did not receive newly claimed output. |
| Disconnect racing PTY spawn | Pass | Outcome converged to either no session or a leased orphan; no unleased live session remained. |
| Explicit termination | Pass | Exact broker-created leader and grandchild exited. |
| Orphan lease expiry | Pass | Exact process group exited, tombstone expired, socket disappeared, and broker exited. |
| Detached replay overflow | Pass | Replay stayed within per-session/global caps, reported dropped bytes, and accepted new interactive input. |
| Broker authentication and endpoint permissions | Pass | Private modes were verified and a wrong broker capability was rejected. |
| Broker `SIGTERM` | Pass | Broker stopped accepting clients, reaped the complete owned process group, removed its endpoint, and exited. |
| Broker `SIGKILL` on macOS | **Fail** | PTY leader exited, but a non-terminal grandchild survived until the test killed the exact recorded process group. |
| Broker `SIGKILL` on Linux CI | Pass | PTY closure reaped the synthetic leader and grandchild; equivalent real-harness and packaged-broker evidence remains absent. |
| Zero-session idle exit | Pass | Broker removed its endpoint and exited. |
| Client restart with 0 / 1 / 20 retained records | Pass | Fresh client connections reconciled exact counts through the typed `list` operation. |

The broker-crash failure is not a test-harness leak: the test explicitly asserts the
survivor as negative evidence and then removes only the recorded broker-created group.
The cross-platform result shows that PTY-master closure reaped this synthetic tree on
Linux CI but is not a complete process-tree ownership primitive on the tested macOS host.

## Real harness evidence

The real trials ran in fresh temporary directories with provider session persistence
disabled. They gave each harness one bounded shell operation that wrote a content-free
marker during an eleven-second command. The first client disconnected before the marker;
the second attached after the marker and stayed through clean harness exit.

| Harness | Same PTY PID | Marker after disconnect | Epoch advanced | Exit | Elapsed |
| --- | --- | --- | --- | --- | --- |
| Codex CLI 0.145.0 | Yes | Yes | Yes | 0 | 19.23 s |
| Claude Code 2.1.218 | Yes | Yes | Yes | 0 | 15.55 s |

Only lifecycle facts and byte counts were observed. Prompts and terminal contents were
discarded in memory and are not included here.

## Local measurements

Run:

```sh
npm run spike:pty-broker:evaluate
```

Each direct or broker terminal count runs in a fresh Electron-as-Node process. Latencies
are 24 sequential input/echo samples and eight resize/redraw samples. Throughput is one
512 KiB synthetic output burst. Reconciliation samples start from a fresh client
connection at each retained-record count. CPU is owner-process CPU over that bounded
measurement, not whole-tree CPU.

### Input/echo latency

| Terminals | Direct p50 / p95 / p99 | Broker p50 / p95 / p99 |
| ---: | ---: | ---: |
| 1 | 0.029 / 0.416 / 0.435 ms | 0.056 / 0.491 / 1.995 ms |
| 4 | 0.050 / 0.340 / 0.496 ms | 0.083 / 0.384 / 0.633 ms |
| 12 | 0.102 / 0.466 / 0.568 ms | 0.155 / 0.405 / 0.665 ms |

### Resize latency

| Terminals | Direct p50 / p95 / p99 | Broker p50 / p95 / p99 |
| ---: | ---: | ---: |
| 1 | 0.023 / 0.087 / 0.087 ms | 0.061 / 0.174 / 0.174 ms |
| 4 | 0.026 / 0.121 / 0.121 ms | 0.070 / 0.182 / 0.182 ms |
| 12 | 0.048 / 0.142 / 0.142 ms | 0.085 / 0.247 / 0.247 ms |

### Throughput and owner footprint

| Terminals | Direct MiB/s | Broker MiB/s | Direct baseline / incremental RSS | Broker baseline / incremental RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 23.09 | 25.18 | 86.98 / 1.63 MiB | 87.77 / 0.88 MiB |
| 4 | 23.00 | 25.32 | 87.25 / 0.34 MiB | 87.94 / 0.00 MiB |
| 12 | 17.49 | 16.89 | 86.61 / 0.00 MiB | 87.73 / 0.06 MiB |

Measured owner CPU during the bounded samples was 31.5% / 10.0% / 4.2% for the direct
1 / 4 / 12 runs and 17.9% / 5.9% / 2.5% for the broker runs. These short values are
scheduler-sensitive and establish no broker CPU advantage; they only show no obvious
copying storm in the sampled run.

Across twenty samples, typed `list` reconciliation after a new client connected measured
0.048 / 0.115 / 0.163 ms p50 / p95 / p99 for zero sessions,
0.037 / 0.058 / 0.155 ms for one, and 0.145 / 4.925 / 6.013 ms for twenty.

This is one local run, not a performance acceptance envelope. Linux, repeated stress,
packaged builds, renderer paint under output storms, system sleep, and real hvir startup
remain unmeasured.

## Security and compatibility findings

Positive evidence:

- private directory/socket/bootstrap modes;
- bootstrap capability removed from disk before service;
- fixed protocol version and bounded frame size;
- exact broker/session/attachment capabilities;
- single-writer epochs;
- fixed metadata schema without launch values or terminal contents;
- no ambient process discovery; and
- termination restricted to exact broker-created records.

Unresolved production questions:

- Unix peer identity is not verified; the prototype relies on the private socket plus
  capability.
- A restarting hvir needs a secure durable reference to broker/session capabilities
  without turning recovery metadata into an ambient authority.
- A protocol-incompatible broker is rejected, but update handoff, old executable lifetime,
  and downgrade behavior are not designed.
- Negative process-group signals still depend on timely `node-pty` exit observation; a
  stronger PID-reuse/process-handle proof is needed.
- Broker crash cannot currently enforce process-tree cleanup.
- Electron-as-Node duplicates a large runtime and has not been tested through packaging,
  signing, notarization, or Linux payloads.

## Next decision gate

A follow-up should evaluate the smallest ownership revision that can kill the exact process
tree even when the central broker is `SIGKILL`ed. Candidates include a lightweight
per-session guardian, a platform-specific parent-death/process-handle primitive, or moving
the attachable owner into a host-side wrapper. That work must:

1. rerun the broker-crash test without test-owned cleanup;
2. prove PID-reuse safety and graceful/forced descendant cleanup;
3. measure the added per-session footprint and blast radius;
4. reduce or explicitly accept the approximately 87 MiB broker baseline;
5. add Linux real-harness/measurement evidence and packaged-host evidence; and
6. compare the resulting local contract with the later SSH-wrapper spike before an ADR
   changes ADR-006 or ADR-010.

Until those gates pass, exact provider resume remains hvir's production recovery layer and
the direct PTY path remains unchanged.

## Reproduction

```sh
npx vitest run test/pty-broker-spike.test.ts
npm run spike:pty-broker:evaluate
npm run spike:pty-broker:real -- codex
npm run spike:pty-broker:real -- claude
```

The real-harness commands consume provider usage and intentionally use bypassed permissions
only inside their disposable temporary directories. They should not run as part of normal
verification or CI.
