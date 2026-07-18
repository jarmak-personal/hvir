# ADR-010: ProjectHost, host-qualified paths, and no remote server

## Context

Remote projects need filesystem, Git, PTY, watch, and loopback-stream behavior without an
installed remote hvir service. Retrofitting host identity after local-only development
would compromise nearly every authority boundary.

## Decision

Every project is registered on a host and every path is a `(host, path)` value. Filesystem,
Git, PTY, watch, and bounded loopback-stream operations go through `ProjectHost`.
`LocalHost` is the default implementation; `SshHost` uses `ssh2` exec, SFTP, direct TCP,
and PTY channels. Remote watching uses bounded polling or a temporary streamed host tool,
never installed server software.

Opening a folder creates a canonical registered-root authority boundary after main verifies
an absolute accessible directory. Subsequent operations are confined beneath it. The
renderer gesture is not itself a durable OS capability: the current threat model trusts
the workbench renderer to request registration, while hostile preview and guest content
cannot do so. Git-worker broker calls are independently pinned and validated in main.

One logical `SshHost` owns host identity, trust, authentication, reconnect state, SFTP and
cache state, and a bounded role-aware pool of physical transports. Control transports
reserve capacity for exec, SFTP, watches, Git, and multiplexed provider telemetry; terminal
transports carry only lifetime-pinned PTYs. Pool growth is lazy, reuses idle capacity,
serializes authentication, and contains auxiliary transport failure to its pinned PTYs.
Central safety defaults bound transports, channels, buffered exec concurrency, and idle
auxiliary lifetime; they may be tuned without changing the singular logical-host contract.

Reusable password or passphrase material may remain only in memory until disconnect or
quit; keyboard-interactive and one-time answers are not cached. Prompted growth has finite
attempts and no modal automatic retry after failure. Provider telemetry is multiplexed per
`(host, provider)` over bounded streams rather than opening one channel per terminal.

## Consequences

Local and remote projects share product and authority paths. Remote latency affects
freshness rather than paint because rendering and parsing remain local or off-thread.
Transport pooling supports many terminals without duplicating host/auth lifecycle, while
bounded failures remain visible and recover through exact harness resume rather than
claiming PTY survival.

## Rejected alternatives

- A vscode-server-style remote daemon, installed helper, SSHFS, or FUSE mount.
- Bare local paths followed by a remote retrofit.
- Trusting worker validation, arbitrary worker commands, or every configured host as active
  authority.
- One `SshHost` per project/workspace/worker, one TCP connection per PTY, or requiring users
  to raise `MaxSessions`.
- Letting control work borrow terminal transports or opening one telemetry follower per
  terminal.
- Caching OTP answers, retrying failed prompts automatically, or scraping terminal output.
