# ADR-055: Connection-scoped remote agent client

> Lifecycle: Active
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Prohibition on cached remote helper files, only for the bundled connection-scoped hvir-agent client; no remote service or daemon is authorized.
> Supersedes: [ADR-053](ADR-053-local-agent-workbench-access.md) | partial | Application-local transport and client-only reference response ownership, only for SSH-forwarded requests and live remote reference commands, plus protected client-path/unavailable metadata and transport-owned PATH setup.

## Context

Agents inside SSH terminals need the existing live workbench commands without a remote
Node or Python runtime. Transport origin must survive command adaptation and subsequent
extension capabilities; a Unix socket pathname or terminal environment cannot authenticate
which process sent a request.

## Decision

Ship a transport-only Rust client under ADR-048's maintained root. It serializes argv,
bounded UTF-8 stdin and nonsecret target defaults using the same public 1.0 JSON-line
framing as the local client, then relays stdout, stderr and exit status. Main owns parsing,
help, discovery, targeting, authorization and command semantics. Remote authoring is
unavailable; complete authoring and offline reference remain on the application machine.
There is no runtime download, credential, second command implementation or remote daemon.

Support Linux x64 and arm64 with static musl binaries, requiring Linux kernel 3.2 on
x64 and 4.1 on arm64. Build against musl 1.2.5 or newer, without dynamic libc dependencies.
Support macOS x64 and arm64 from macOS 11, using only system libraries. Pin the client
toolchain and locked dependencies in focused verification and exact-source release jobs.
Unrelated TypeScript verification still requires no Rust installation. Each native package
contains all four clients and a digest/source manifest; package preparation refuses an
incomplete or mismatched set. Development without these artifacts reports remote client
unavailability while retaining all other features.

A remote-client coordinator prepares access on the first remote terminal launch, shares
one preparation per logical host and current SSH generation, and reuses that generation's
forward for subsequent terminals. A bounded preparation failure supplies plain-language
unavailability without failing the terminal. ProjectHost owns detection exec, SFTP and the
stream-local primitive. The SSH adapter supplies immutable trusted host and connection
generation, revokes old generations before replacement and charges incoming channels to
the actual physical transport's existing capacity until physical close. Forwarding never
borrows a tunnel budget for a control transport.

Reuse ADR-026's checked user-owned 0700 hvir directory selection. A dedicated agent-client
subdirectory retains at most three client revisions and 48 MiB, with each client bounded
to 16 MiB. Upload to an exclusively created random leaf, verify size, digest and mode,
then atomically publish without replacement. Exact ownership markers bind retained objects
and cleanup. Physically settled failed transfers use exact recorded identities for immediate
bounded cleanup. If disconnect or uncertain ownership prevents cleanup, a new exclusive revision
can prepare the same hash while preserving the abandoned leaf; every pending revision counts
against the same revision, byte and entry bounds. Recognized private directories without valid
receipts remain opaque and preserved, reserving one full client allowance; their names never
confer reuse, execution or retirement eligibility. Live forward leases prevent client deletion;
interrupted transfers never execute. Reconciliation inspects only bounded immediate entries in this dedicated namespace;
unsafe or excessive contents refuse preparation rather than scan or delete unrelated files.
Only proven unleased obsolete objects are removed. Offline hosts may retain material until
a later supported reconciliation. Unavailable ABI, no-exec storage and cleanup failures are
reported without changing host mount policy or disabling other features.

Protected nonsecret terminal metadata adds the exact bundled client path and an unavailable
explanation to ADR-053's endpoint and workspace/session defaults. The PTY supervisor awaits
bounded preparation within its existing launch cancellation lifetime and a transport-owned
PATH prefix makes hvir-agent available in remote terminals. Stale endpoints never select
another generation or replay an interrupted request.

The main-owned forwarded scope admits only workspaces and sessions on its trusted SSH host
by default. Scope intersects standing access and existing installation/connector grants at
every operation. Discovery and cursor identity retain host and generation; caller fields
cannot assert origin, approvals or broaden targets. Action provenance retains a main-only
capability authority through nested actions and connector admission. Application-host native
execution requires a separate trusted, explicit grant bound to forward generation,
installation and accepted revision, action, capability, execution host and destination
workspace. Grants are reused while unchanged and revocation interrupts dependent work.
The trusted Settings surface manages finite grants; socket and guest protocols cannot.
Actions capture their standing additional grants at admission. Adding grants does not widen or
interrupt admitted work; removing a grant fences actions bound to it while unrelated actions
and views retain their forward lifetime. Views refuse reuse across local and restricted origin
classes; same restricted-origin reuse retains its restrictions.

Off, disconnect and application exit revoke forward admission before releasing streams and
the socket. Late preparation or results cannot restore it. Known completed effects remain
completed; loss after dispatch reports uncertainty and never promises rollback. Any process
running under the remote SSH account, and remote root, can use that socket. There is no
per-agent or per-session authentication and native connectors retain their account's OS
authority; a grant is not OS confinement.

Successful socket creation adds an inode receipt to the private lease. Physical close precedes
exact socket and lease cleanup; stale dead receipted sockets are reconciled conservatively.
The socket namespace shares the finite directory-entry bound. Unacknowledged or replaced
socket objects are preserved rather than attributed from their pathname alone.

## Consequences

Local and SSH agents adapt the same workbench owners, with trusted transport provenance
remaining distinct from nonsecret context defaults. Cache and channel limits can refuse
additional remote access; ordinary terminals, local access and other hosts remain usable.
Exact-source builds and native execution are separate evidence, and unavailable real-host
or signed installed environments remain explicit final acceptance requirements.

## Rejected alternatives

- Require a remote interpreter, install a service, or download a client at runtime.
- Relay remote bytes through the local socket and erase their trusted origin.
- Infer origin or consent from environment, argv, workspace IDs or harness permission modes.
- Reimplement command help and policy in Rust, or require Cargo for unrelated verification.
- Unbounded caches, pathname-only cleanup, removal of live clients or replay after reconnect.
