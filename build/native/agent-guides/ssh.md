# hvir-agent over SSH

Enable Agent access in Settings > Extensions before starting an SSH terminal. hvir prepares
the matching bundled native client and a private Unix socket through the existing connection.
Run `hvir-agent workspaces`, `hvir-agent sessions`, or `hvir-agent help report` in that terminal.
The protected HVIR_AGENT_ENDPOINT, HVIR_AGENT_CLIENT, HVIR_AGENT_WORKSPACE and
HVIR_AGENT_SESSION values describe that exact connection and terminal. They are not secrets or
credentials. HVIR_AGENT_UNAVAILABLE gives a bounded explanation when setup could not complete.
Restart a terminal after enabling access or reconnecting; old values never select a new socket.

The remote client requires Linux x64 (kernel 3.2+) or arm64 (kernel 4.1+) with its statically
linked musl ABI, or macOS 11+ on x64 or arm64. It needs no Node or Python runtime. The SSH host
must provide POSIX sh, SFTP, uname, id, stat, and Unix stream-local forwarding. hvir ships the
client inside its package and uploads it into a checked SSH-user-owned 0700 directory under
XDG_RUNTIME_DIR/hvir or TMPDIR/hvir-$UID (with /tmp as the safe fallback). Storage must allow
executables. hvir reports unsupported hosts, unavailable forwarding, unsafe directories,
no-exec storage or an interrupted connection without changing host policy or replaying work.

Any process running as that SSH user, and remote root, can use the socket. A workspace or session
value selects context; it does not identify or authenticate an agent. A harness can require its
own ordinary command/socket approval. hvir neither changes nor infers those permissions.

Default discovery and targets stay on the originating SSH host. In Settings > Extensions,
an additional SSH action grant can permit a specific already-approved native connector on
another host for one extension action and remote destination. The grant identifies the forward
generation, accepted installation revision, action, execution host and destination workspace.
Unchanged access needs no repeat prompt. Revoking it interrupts dependent requests. A reconnect,
changed revision or changed binding requires a new grant. Existing extension and connector
approvals, standing access and optional destructive confirmation still apply. Native programs
run with their account's OS authority; these controls are not OS confinement.

Remote help and guide commands use the running application's installed reference. Authoring,
scaffolding, validation and optional agent-skill installation run on the local machine; they
are not remote operations. Local offline help continues to work with hvir closed and access Off.

Off, disconnect and application exit revoke the forward. An interrupted action may have already
made effects; a lost result is uncertain, not rollback. hvir never retries the request. The
private cache holds at most three revisions and 48 MiB, preserves live leases, and removes only
verified owned obsolete objects. An unreachable host can retain files until later reconciliation.

A long per-user temporary directory keeps the client cache there and uses a separately checked
0700 /tmp/hvir-$UID directory for the short socket name. macOS socket paths stay below 104 bytes.
The cache limits each client to 16 MiB and bounds directory entries. Fresh interrupted transfers
and lease records are preserved for 24 hours; older exact owned transfers can be reconciled,
and older leases are removed only when the bundled client confirms the socket is dead. Unknown
or externally replaced objects are preserved and setup reports unavailable. Live streams keep
their lease until physical close. Turning access Off and enabling it again creates a new forward
identity, so a queued decision cannot grant a later connection accidentally.
