# ADR-046: Explicit Skillager library and workspace exposure authority

> Lifecycle: Active
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Registered-project confinement for the named local personal-library metadata, review, and acceptance capability.
> Supersedes: [ADR-030](ADR-030-bounded-project-file-operations.md) | partial | No-replacement rule only for explicitly confirmed, verified unchanged Skillager-managed workspace exposures.

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
settings section. Open Skills from the sidebar's workspace views as a closable viewer tab beside
documents and Git history. Switching, closing, and reopening it preserves the terminal pane and
session rail. Personal library and This workspace are perspectives within that tab.

Enabling reveals the resolved local executable and exact registered library location. Connecting
grants metadata access to that one local library identity and location; it does not approve any
content. Library identity or location changes require reconnecting, not silent adoption. Ordinary
content edits follow refresh and explicit review without reconnecting. Explicit Review content
grants confined content/diff access for the selected identity and version. Accept library changes
is a separate confirmation of the exact reviewed version through Skillager. Disabling revokes
the connection, content resources, and outstanding requests. The library remains external to
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
search indexes, and local projection writes. hvir consumes public CLI contracts. It never reads
Skillager SQLite, indexes bodies, recreates trust/hashing policy, or treats Git history as approval.

ProjectHost supplies host execution and file/transfer mechanics. Bootstrap constructs and
disposes owners; feature IPC rebuilds validated requests through existing renderer authority and
delegates to the capability. Renderer views depend on feature state and typed ports. Shared
contracts import no main, renderer, Electron, or process implementation. Pure policy imports no
React or preload. These directions also govern erased type imports. Existing direction checks
remain authoritative; new feature invariants belong in that same policy owner. Harness providers
and composition roots gain no Skillager workflow state. Ordinary source budgets apply.

Connection, renderer generation, originating workspace, content tab, and individual request are
distinct scopes. A request snapshots the selected local source, host-qualified destination,
agent, mode, source version, and existing target state. Selection changes cannot retarget it.
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

Refresh on Skills visibility, after management actions, and every 60 seconds only while Skills
is visible and the app foregrounded. Observe only the active workspace. Expose last-check time
and stale/unavailable state; do not infer current status from a library-only result. Refresh is
metadata work: it neither opens bodies nor accepts, exposes, updates, restarts sessions, or
creates terminal attention. Library-review badges and workspace-update badges remain distinct.

Execution stays off paint with abortable processes, bounded stdout/stderr, finite deadlines,
and bounded concurrency without an unbounded queue. Initial submitted search admits 1,000
UTF-8 query bytes, 50 rows, a 4 MiB JSON response, 64 KiB stderr, and a 30-second deadline;
there is one search per viewer generation and at most two Skillager processes application-wide.
A replacement query cancels the previous one. Index construction has visible loading while
input and terminal remain usable. Bounds fail visibly instead of presenting truncated JSON as
complete. Other commands retain independently explicit response/deadline limits appropriate to
metadata, content, or transfer; metadata refresh cannot silently inherit bulk content authority.

### Explicit management

Initially manage owned personal skills and direct project exposures for Codex and Claude Code.
Local Full skill copies reviewed files; local Stub installs an activation handle whose use
requires Skillager on that agent's host. Exposure is workspace state, never proof that a running
agent loaded the instructions.

Preview add, mode change, update, removal, and library acceptance before confirming. The CLI
must bind apply to the previewed source identity/version, destination, agent, mode, and target
state under mutation authority. Every affected file, including Working/router/supporting
instructions, must be disclosed. hvir validates versioned schemas and per-item outcomes;
successful process exit alone does not establish success. Skillager must bind the reviewed
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

SSH supports Full skill files only. Skillager must provide a portable approved package contract
with canonical identity/version, complete relative file manifest, normalized modes, integrity
evidence, all projected supporting effects, and explicit runtime prerequisites. It must provide
remote observation/receipt and compare/apply semantics for managed targets without relying on
a temporary local catalog path as an activation path. No remote Skillager executable, Working
skill, router, listener, installed helper, or activation RPC is required or introduced.

hvir owns bounded transport and request lifetime, reusing ProjectHost streams and transfer
verification rather than creating a second filesystem authority. Stage on the destination,
verify the complete manifest, revalidate both source approval and exact unchanged managed target,
then publish through narrowly owned compare/apply mechanics. Never weaken ordinary Files
no-overwrite behavior or assume no-replace rename implements atomic replacement. Remote update
and removal require exact managed identity and unchanged-state proof; changed, pinned, blocked,
unmanaged, or unverifiable targets remain protected. Disconnect prevents later publication;
cleanup can remove only exact coordinator-created staging entries when reachable, and retained
or uncertain effects are visible.

A missing CLI contract disables its affected action; design acceptance is not evidence of CLI
support. Portable packaging, remote receipts, or safe replacement may require upstream changes
before SSH management becomes available. Remote Stub activation remains outside scope.

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
