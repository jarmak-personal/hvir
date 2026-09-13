# ADR-046: Explicit Skillager library and workspace exposure authority

> Lifecycle: Partially superseded
> Superseded by: [ADR-048](ADR-048-explicit-skillager-project-setup.md) | partial | Local project setup terminal handoff and Working installation, existing-project metadata presentation, and post-handoff terminal lifetime only.
> Superseded by: [ADR-047](ADR-047-explicit-skillager-library-initialization.md) | partial | Initial personal-library connection and first-use presentation only; add explicit local initialization followed by verified metadata connection.
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Registered-project confinement for the named local personal-library metadata, review, and acceptance capability.
> Supersedes: [ADR-030](ADR-030-bounded-project-file-operations.md) | partial | No-replacement rule only for explicitly confirmed, verified unchanged Skillager-managed local exposures and hvir-managed SSH deployments.

## Context

Reusable instructions have two distinct lifetimes: their accepted personal-library version and
their copy in a particular workspace. A view-first workbench can expose that relationship and
offer small, reviewed management actions without becoming an authoring IDE or extension host.
Catalogs containing thousands of skills also require asynchronous metadata search instead of
loading instruction bodies into the workbench.

The local personal library lies outside registered project roots. ADR-045 permits explicit
outside-project document viewing on the originating host; it does not authorize library
enumeration, approval, or local-source management while an SSH destination is selected.
ADR-030's no-replace transfer primitives do not supply managed-exposure replacement authority.

## Decision

### Product surface and grants

Provide an optional built-in Skillager integration, disabled by default, with a dedicated
settings section. Skills is a peer sidebar mode beside Files and Git, following the existing
workbench rail-mode convention. Personal library and This workspace metadata browsing and
submitted search live on the left. Selecting metadata opens a closable skill detail tab in the
normal main viewer beside documents and Git history. Bodies and diffs require explicit Review
content. Sidebar switches preserve open viewer tabs, the terminal pane, and the session rail.
There is no separate Workspace views launcher.

While disabled, the only discovery control is Enable Skillager in Settings. Skills navigation,
commands and shortcuts, destination/agent controls, badges, status text, disconnected placeholders,
and retained feature-owned content are absent. Executable, library, and connection settings appear
only after enabling. Enabling does not connect or reopen prior feature tabs.

Skillager remains user-installed and user-managed. hvir neither bundles it nor manages it as an
application/runtime dependency. It does not install or upgrade Skillager, bootstrap Python or uv,
change package environments or PATH, execute package-manager commands, or inject terminal input.
A managed-installation capability requires a separately accepted scope change. Isolated
contributor contract fixtures grant no application installation authority.

When enabled and the local executable is missing, show “Skillager wasn’t found. Install Skillager
in your local terminal:” with selectable `uv tool install skillager` guidance and Check again.
Check again performs only the bounded local executable/version/contract probe. Finding the CLI
returns to explicit library connection; it does not connect or mutate anything. Missing Settings
must not claim a resolved executable or version. Distinguish missing executable, selected-path
problems, unsupported versions/contracts, and command failures; incompatible installations receive
truthful compatibility guidance and user-managed remediation, never silent fallback or upgrades.

Enabling reveals the resolved local executable and exact registered library location. Connecting
grants metadata access to that one local library identity and location; it does not approve any
content. Library identity or location changes require reconnecting, not silent adoption. Ordinary
content edits follow refresh and explicit review without reconnecting. Explicit Review content
grants confined content/diff access for the selected identity and version. Accept library changes
is a separate confirmation of the exact reviewed version through Skillager. Disabling revokes
the connection, content resources, outstanding requests, search and periodic demand. It closes
feature-owned tabs, dialogs, and toasts, clears feature notifications, and rejects stale callbacks.
If Skills was selected, return the sidebar to Files and the viewer to its last remaining ordinary
tab or normal empty state. Preserve unrelated viewer and terminal/session state. Neither restart
nor re-enabling silently restores feature surfaces. The library remains external to
project registration; this grant is not general renderer filesystem access.

Main validates local host identity, canonical library/skill roots, and relative entries through
ProjectHost. No escaping symlink, prefix lookalike, traversal, alternate host, or source path
returned by the CLI widens that grant. Content remains read-only in hvir; authoring stays with
the user's terminal or agent. HTML retains its opaque sandbox, self-contained resources, and
response-header CSP. Existing document size bounds apply. Automatic embedded assets remain
confined to the reviewed canonical document's parent and descendants. ADR-045's independent
document activation and originating-workspace lifetimes remain unchanged.

### Ownership and lifecycle

One named main-owned Skillager capability coordinates connection, metadata, explicit review,
and exposure requests through narrow execution, registered-workspace, and content-review ports.
Skillager owns discovery, canonical identity, approval hashes, scanner/linter decisions, history,
search indexes, local projection writes, and transport-neutral approved Full skill exports. hvir
consumes public CLI contracts. It never reads Skillager SQLite, indexes bodies, recreates
Skillager trust/approval hashing, or treats Git history as approval. hvir owns remote deployment
records and file fingerprints separately from Skillager library identity and approval.

ProjectHost supplies host execution and file/transfer mechanics. Bootstrap constructs and
disposes owners; feature IPC rebuilds validated requests through existing renderer authority and
delegates to the capability. Renderer views depend on feature state and typed ports. Shared
contracts import no main, renderer, Electron, or process implementation. Pure policy imports no
React or preload. These directions also govern erased type imports. Existing direction checks
remain authoritative; new feature invariants belong in that same policy owner. Harness providers
and composition roots gain no Skillager workflow state. Ordinary source budgets apply.

Connection, renderer generation, originating workspace, content tab, and individual request are
distinct scopes. Leaving the Skills sidebar releases its search demand; closing a skill detail
tab releases that tab's content without canceling an independently visible sidebar. Hiding every
feature surface releases periodic metadata demand. A request snapshots the selected local source,
host-qualified destination, agent, mode, source version, and existing target state. Selection changes cannot retarget it.
Workspace/project closure, renderer replacement, connection revocation, host replacement/loss,
and shutdown cancel descendants and reject late publication. Disposal is idempotent in reverse
ownership order. A mutation already beyond its commit point reports its actual or uncertain
effect; cancellation never licenses blind retry or a false claim of no effect.

### Metadata search and observation

Submit search with Enter or Search. Request at most 50 ranked metadata rows, preserving safe
match reasons and external collection/package identity without importing those sources. Scope
must apply in Skillager before the result window. There is no inferred total, pagination, or
local replacement search engine. Explain accepted-body coverage of the first 50,000 characters;
pending drafts remain browsable in metadata, separate from approved-body search.

Personal library search uses personal approval authority and reports exposure as unknown until
a separate active-workspace status observation. All available to this workspace uses local
workspace context, project decisions, and exposure-aware ranking. For SSH destinations default
to Personal library and disable All available until a truthful remote catalog contract exists.
Never execute an SSH path as a local cwd. A local source and SSH destination stay separately
named throughout browsing, review, preview, and results.

Refresh on Skills visibility and after management actions. Periodic refresh runs every 60
seconds only while connected, the app is foregrounded, and either the Skills sidebar or a
Skillager-owned viewer is visible. Hidden and disabled feature surfaces own no periodic demand.
Observe only the active workspace. Expose last-check time and stale/unavailable state; do not infer current status from a library-only result. Refresh is
metadata work: it neither opens bodies nor accepts, exposes, updates, restarts sessions, or
creates terminal attention. Library-review badges and workspace-update badges remain distinct.

Execution stays off paint with abortable processes, bounded stdout/stderr, finite deadlines,
and bounded concurrency without an unbounded queue. Initial submitted search admits 1,000
UTF-8 query bytes, 50 rows, a 4 MiB JSON response, 64 KiB stderr, and a 30-second deadline;
there is one search per sidebar request generation and at most two Skillager processes
application-wide. A replacement query cancels the previous one. Index construction has visible loading while
input and terminal remain usable. Bounds fail visibly instead of presenting truncated JSON as
complete. Other commands retain independently explicit response/deadline limits appropriate to
metadata, content, or transfer; metadata refresh cannot silently inherit bulk content authority.

### Explicit management

Initially manage owned personal skills and direct project exposures for Codex and Claude Code.
Local Full skill copies reviewed files; local Stub installs an activation handle whose use
requires Skillager on that agent's host. Exposure is workspace state, never proof that a running
agent loaded the instructions.

Preview add, mode change, update, removal, and library acceptance before confirming. Each
mutation owner must bind apply to the previewed source identity/version, destination, agent,
mode, and target state under its mutation authority. Skillager owns library acceptance and local
projection mutations through public CLI contracts. For SSH deployments, hvir binds the verified
approved export to the exact remote destination and unchanged target, and owns safe publish,
update, and removal through ProjectHost. Every affected file, including supporting instructions,
and each deployment-record effect must be disclosed. hvir validates versioned CLI schemas and
per-item outcomes for Skillager-owned actions and observes the actual outcome of its own remote
operations; successful process exit alone does not establish success. Skillager must bind the reviewed
content bytes or complete tree to the source version, including pending drafts without Git
history. A confined read or matching metadata before and after a mutable read is not that proof;
hvir must not recreate the CLI hash algorithm to manufacture it. Unknown schemas, refused/skipped
items, stale previews, and uncertain completion remain explicit states.

Replace only an unchanged, verified managed exposure after explicit review. Preserve modified,
pinned, blocked, or unmanaged targets; there is no force overwrite or pin change. A mode change
that advances the source version also previews that update. Accepting a library version leaves
workspace copies untouched. Removing an exposure retains the canonical library skill and every
other workspace copy. Updates compare locally available accepted versions, not internet releases.

### Local source to SSH destination

SSH supports Full skill files only, using the same Add, Update, and Remove flow as local
workspaces. Destination identity and actual connection/failure state remain visible. Users do
not configure a remote Skillager installation or library. Skillager owns the local library's
approval and canonical identity/version and must supply a supported transport-neutral approved
Full skill export: exact relative files, normalized modes, integrity evidence, all supporting
file effects, and declared runtime prerequisites, verifiably bound to the approved source/version.
Skillager needs no SSH awareness, credentials, remote paths, observation APIs, or remote mutation
commands. No remote Skillager executable, Working skill, router, listener, installed helper, or
activation RPC is required or introduced. Remote Stub activation remains outside scope.

hvir owns all SSH connection and host authority through ProjectHost, remote target observation,
deployment records and file fingerprints, transport, staging and verification, stale-target
protection, safe publish/update/removal, cancellation, reconnect reconciliation, and cleanup.
It reuses ProjectHost streams and file/transfer mechanics without creating a second filesystem
authority. hvir stages on the destination, verifies the complete exported file set, revalidates
source approval through the supported local contract and the exact unchanged managed target,
then publishes through narrowly owned compare/apply mechanics. Existing no-replace transfer
operations do not prove safe managed replacement; that must be implemented and validated in hvir.
Ordinary Files retains its no-overwrite policy.

hvir's deployment records bind its own completed delivery to the exact host, workspace, agent,
exported source identity/version, and deployed file fingerprints. These records and destination
observations distinguish hvir-managed delivery from modified, unmanaged, or unverifiable targets.
They neither mint library approval nor recreate Skillager trust hashing, private state, or
sidecars. A Skillager-looking file at a remote target is not evidence of hvir ownership. Fingerprints
prove destination state for hvir's operations; Skillager's public export supplies source approval
and integrity evidence. Record effects remain separate from the exported workspace files.

Remote update/removal requires exact managed identity and unchanged-state proof. Changed, pinned,
blocked, unmanaged, or unverifiable targets remain protected. Disconnect prevents late publication;
reconnection reconciles hvir's recorded and observed state before another action. Cleanup removes
only exact coordinator-created staging entries when reachable; retained or uncertain effects are
visible and never license blind retry.

A missing local export contract disables the affected SSH delivery action. The upstream
prerequisite is the transport-neutral approved Full skill export with verifiable source/version
binding. Remote observation, records, safe destination mutation, and reconciliation are hvir
implementation and acceptance obligations, not upstream Skillager remote APIs. Design acceptance
is not evidence that either the export contract or hvir's safe destination management exists.

## Consequences

Users can distinguish library approval from workspace rollout and keep both under explicit
control. Large catalogs remain CLI-owned; cold-index cost affects search freshness rather than
paint. A separate library grant supports local sources beside remote work without registering
the library as a project or broadening ordinary document/file authority.

The integration depends on independently evolving public CLI contracts. Refusal, unsupported
operations, and uncertain results cost visible unavailable states. Contract and subprocess
fixtures establish CLI behavior; browser/Electron lifecycle and real SSH acceptance remain
separate evidence. No UI mockup substitutes for scale or transport validation.

## Rejected alternatives

- Ambient filesystem access, direct database reads, or hvir-owned body indexing duplicate
  Skillager authority and widen the viewer's scope.
- Automatic library approval or bulk workspace rollout erases the review/update distinction.
- Treating CLI dry-run output or exit zero as mutation authorization ignores stale inputs and
  per-item refusals. Force replacement would consume user edits or pin policy.
- Registering the personal library as a project conflates durable library management with
  workspace navigation and does not solve local-source/SSH-destination authority.
- Remote Skillager installation, stubs, activation bridges, or global exposure enlarge the
  runtime and deployment scope. Portable Full skill files preserve the no-server boundary.
- Pagination guesses, client-side scope filtering after a result limit, or per-keystroke CLI
  searches misrepresent coverage or create avoidable process churn.
