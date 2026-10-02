# ADR-053: Local agent workbench access

> Lifecycle: Active
> Supersedes: [ADR-012](ADR-012-harness-providers-launch-profiles.md) | partial | Protected terminal environment vocabulary only: add instance endpoint and exact workspace/session targeting.
> Supersedes: [ADR-009](ADR-009-hierarchical-attention.md) | partial | Terminal-only attention vocabulary: add separate quiet report attention, cleared by viewing that report.

## Context

Permitted local agents need metadata, document presentation, reports and declared actions.
They must not acquire private renderer IPC, desktop-selection authority or terminal control.
Later SSH clients need the same command protocol without reimplementing command policy.

## Decision

A local-agent access owner manages instance identity, disabled-by-default standing access,
confirmation policy and revocation. Per-installation action consent is persisted by the
existing extension activation/state writer with its serialized atomic writes. The current
installation schema defaults an absent consent field to off and rejects present non-booleans;
new publications persist the explicit boolean without restoring authorization. Writer loss
revokes action lifetimes, and instances without that writer cannot change consent. Global
agent inspection and reports remain independent of extension write ownership. The agent
adapter reads that narrow consent port and adapts existing context, action, document
and host owners through explicit ports. The renderer resource qualifier identifies where
content is presented; the initiating caller remains agent throughout subsequent requests.
No request, terminal environment value or extension can assert a human decision or forwarded
origin. Same-user local processes are one trust class. A future main-owned forwarding adapter
supplies SSH provenance separately from request data.

The application owns a private Unix socket beneath a checked user-owned 0700 directory in
the macOS per-user temporary directory or Linux XDG runtime directory (temporary-directory
fallback). Socket paths fit the 104-byte macOS bound. Only proven dead, same-user sockets are
removed by a focused LocalHost application adapter; live instances remain distinct. The
standalone CLI only reads and probes this fixed namespace: it cannot create directories or
delete endpoints. Its other physical filesystem edge reads only fixed shipped reference assets. Application exit revokes work before socket cleanup.
The process-neutral framing contract carries argv, bounded stdin and explicit target defaults;
responses carry stdout, stderr and exit status. Local Node and later Rust clients transport
this contract. One command-reference owner describes and parses commands; offline help reads
only shipped reference assets and requires no display, application, connector or user state.

The PTY supervisor supplies protected nonsecret HVIR_AGENT_ENDPOINT, HVIR_AGENT_WORKSPACE and
HVIR_AGENT_SESSION values. They identify the exact launched instance and live terminal target,
never credentials or authority. Overrides/unsets in harness profiles are refused. Stale values
fail rather than selecting another instance, workspace or session. Outside hvir, one live
instance is selected automatically; ambiguity requires explicit selection.

Standing authorization allows only already-admitted operations. Optional destructive
confirmation applies to the closed delete/replace effect vocabulary and declared extension
effects; it cannot classify native programs or prove confinement. A trusted finite decision
binds the immutable caller, installation, action, target, input and access generation. Stricter
settings, cancellation or expiry revoke uncommitted work. Completed effects remain truthful.
Harness permission modes are neither inferred nor changed; a harness sandbox does not constrain
work executed by hvir under hvir's own admitted authority.

A viewer-owned in-memory report store retains bounded workspace-qualified text/Markdown content
after command exit. Reports have real opaque identity and replacement handles, no fake path or
diagnostic-report storage. Markdown parsing/highlighting reuses the worker; automatic resources
are inert before DOM publication. Explicit human file-link clicks retain ADR-045 authority,
with the report workspace root as link base. Agent document opening remains canonically confined
to registered roots and returns presentation metadata only. Publishing preserves focus by
default. Quiet report badges roll up to workspace/project rows independently of terminal and
OS attention, and viewing clears only the viewed report's badge.

Native packages install hvir-agent beside hvir. JavaScript executes in the installed Electron
binary using ELECTRON_RUN_AS_NODE. The RunAsNode fuse stays on: any local process can use that
binary as a Node runtime with hvir's macOS permissions. Packaging and signed-package evidence
must retain this deliberate tradeoff rather than claiming fuse-hardening that breaks the CLI.

## Consequences

Agent work shares existing capability policy while keeping transport, static reference and
report lifetimes focused. Finite request/report limits refuse overload without blocking paint.
Socket access may need explicit ordinary harness command/socket approval; hvir does not change
those permissions. Remote transport and complete author onboarding remain separately owned.

## Rejected alternatives

- Private IPC, synthetic user gestures, selection-dependent dispatch or another action registry.
- TCP listeners, per-agent tokens, a daemon, startup instruction injection or MCP dependency.
- Fake report files, scripts, automatic file/network resources or general file-content retrieval.
- Harness-mode inference, blanket native confinement claims or a model-based effect classifier.
