# ADR-051: Approved finite connector execution

> Lifecycle: Active
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Registered-root requirement for explicit approved connector execution and its application-local working context only.

## Context

User-installed tools supply extension information without becoming built-in integrations.
Native approval differs from approval of isolated UI. A working directory cannot confine
a native executable, and interrupted execution cannot prove rollback or termination of
arbitrary descendants. Skillager's measured 5,000-skill workload includes commands lasting
81 seconds and responses exceeding 2 MiB.

## Decision

A named connector execution owner admits finite structured commands through narrow
`ProjectHost` ports. Local and SSH adapters retain their existing process and transport
mechanics. Core understands no tool-domain schema, database, approval, or mutation semantics.
Connectors declare identity, description, application-local or workspace context, deadline,
output limit, and configurable environment variable names. Discovery reads declarations only.

Trusted Settings lets the user select a configured host and absolute executable path, inspect
its canonical path and configuration, and explicitly approve native host-account authority.
Absolute selection avoids executing a resolver or probe before approval; ambient PATH is not
executable selection. Symlinks resolve through `ProjectHost.realpath`; a changed canonical
target requires a new decision. Approval binds installation identity, the complete known
connector declaration, host, selected and canonical executable paths, and configuration.
Each command pins the activation and exact approval. Explicit package revision actions reuse
unchanged approval. Changing executable bytes in place at the same canonical path needs no
decision and executable contents are never hashed. UI approval grants no native execution.

Configuration contains a bounded argument prefix and only declared environment overrides.
Commands inherit the selected host account's normal environment, with those explicit overrides;
hvir neither copies the local environment to SSH nor records environment values in diagnostics.
Arguments are structured values, never an extension-provided shell command. Native programs may
use the account's files, credentials, network, and subprocesses. Working directories, action
labels, and effect declarations confer no confinement or verified read-only guarantee.

Application connectors use a platform-owned local scratch directory beneath extension state,
without project registration or inheriting the selected workspace. Workspace connectors pin an
explicit live host-qualified workspace root and an independently approved executable on that
host. Existing project filesystem, Git, PTY, watch, and document authority is unchanged.
Disconnected execution never retargets to local or another workspace and never automatically
replays on reconnect. Trusted setup may explicitly connect a configured SSH host; discovery and
guest status queries cannot trigger authentication or tool probes.

At most four executions run per extension and sixteen application-wide, with no execution
queue. A declaration chooses 1–180 seconds and 1 byte–4 MiB combined output. Capacity remains
reserved until underlying transport work settles, even when the caller has been interrupted.
The public owner clips actual returned bytes because transport limits can overshoot a chunk.
Completed output is retrieved in bounded UTF-8 pages using caller-bound opaque receipts, at
most sixteen receipts, 32 MiB globally, four receipts per extension, and a 30-second retention
lifetime. Every page revalidates activation, approval, host, context, initiating caller and
request/action lifetime. Receipts are transient, revoke with their authority, and confer no
filesystem capability. Pages fit the complete existing 16 KiB bridge envelope after JSON encoding.
No stdin capability is introduced without a concrete consumer.

Explicit actions consume D4's exact admitted invocation, caller and authorization and remain
independent executions when hidden. Ordinary view and updater requests are refreshes: they
require current trusted visible demand qualified by their application or workspace context.
Refreshes share only identical activation, approval, command and working context, with at most
one common-source execution and a one-second minimum admission interval per source. Source
records are bounded; no demand admits no new refresh. Shared work has separate caller lifetimes;
ending one caller cannot cancel another live caller. Updaters gain no action or agent authority.

Outcomes distinguish not-started admission refusal, completed exit, and interrupted/uncertain
execution. Once dispatch reaches `ProjectHost.exec`, failure is conservatively uncertain.
Truncation always remains explicit and prevents a complete outcome. Status and output are data;
exit zero alone cannot assert tool-domain success. Cancellation releases hvir-owned resources
without claiming rollback or that SSH channel closure killed a remote process tree. Revocation
precedes cleanup; late output cannot create access. Disabled/replaced activations, writer loss,
view/context closure, host disconnect, and application exit revoke dependent requests and pages.

Authority-bearing approval persistence uses the existing extension writer transaction and
atomic `ProjectHost` writes. A writer reloads state before admission; malformed approval state
fails closed for connector access without disabling independent isolated views. Forgetting
platform setup removes its grants, preserving external tool and domain data.

## Consequences

Local libraries work independently of remote selection. Tool authors own domain meaning while
hvir owns native trust, finite admission, provenance and truthful outcomes. Real Electron and
host-adapter evidence supplement owner tests; real SSH walkthroughs remain release evidence.

## Rejected alternatives

- Arbitrary workbench IPC, shell strings, ambient PATH probes, or tool-specific core executors.
- Executable-content hashes for interpreted tools, or treating a directory as native confinement.
- Unbounded output, polling, queues, persistent connector servers, or automatic retry on reconnect.
- Sharing explicit actions with refresh work, or claiming cancellation reversed native effects.
