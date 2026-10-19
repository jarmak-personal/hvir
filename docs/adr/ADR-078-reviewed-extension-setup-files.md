# ADR-078: Reviewed extension setup files

> Lifecycle: Active

## Context

An agent can prepare the paths and configuration needed by a multi-tool extension, but
copying them into individual permission forms repeats work. A portable file cannot carry
installation authority or replace the person's decision about actual local and SSH targets.

## Decision

Trusted Settings may generate a versioned template from the selected installation's public
declarations and import one bounded JSON proposal for that enabled installation. Templates
contain unresolved selections and declaration hints, never saved configuration or permission.
The closed proposal schema accepts literal structured configuration, configured hosts, exact
registered workspaces, application-local roots and optional per-extension agent access.
Omission leaves setup unchanged. Global Agent access and session launcher trust stay separate.

A named setup coordinator pins one immutable review to the current installation, activation,
trusted renderer and exact host/workspace lifetimes. It prepares rows sequentially through the
existing owners, copies their checked display identities and prior bindings, and immediately
cancels each token. No approval token survives the human review. The review has a ten-minute
absolute lifetime. Changed access and replacements are visible; unchanged access is collapsed.
Arguments and masked environment overrides remain secondary details.

On Apply, the coordinator obtains a fresh token for each selected change and compares the
complete prepared identity and exact prior binding with the review before using the existing
writer. The native and source owners project complete resulting global count and byte usage
using their own replacement and serialization policies, then recheck every serialized save.
Projection reserves no capacity. Prior-binding checks live in those owners, including stale
declarations and independent workspace read bindings. The activation owner retains the
per-extension agent setting and its immediate revocation behavior.

Writes are independent. Cancellation, closure, authority loss, activation change or applicable
host/workspace loss stops remaining writes and fences late completions. Submitted writes are
awaited; completed and uncertain outcomes survive without rollback or automatic replay claims.
One setup coordinator owns the bounded review, while existing permission owners keep all
canonicalization, admission, persistence and revocation. ProjectHost owns file and metadata
access. Preparation executes no program and reads no source bodies.

All unaffected ADR-051/057/068/073/074/075/077 authority rules remain in force. Public proposal
contracts depend only on public data and validation leaves. Trusted IPC adapts the setup
coordinator; composition roots construct, wire and dispose it. No package or guest obtains a
proposal submission or approval command.

## Consequences

One human decision can configure several independent capabilities without merging their trust.
Concurrent setup or changed targets require a fresh review. Large proposals remain bounded by
the existing native and source stores and preserve unrelated installations and host bindings.

## Rejected alternatives

- Watching files or reconciling desired state would turn authored data into unattended consent.
- Retaining hundreds of prepared tokens would consume finite owner capacity during review.
- A combined grant store, rollback protocol or generic setup framework would duplicate owners.
- Exporting saved configuration could expose credentials and falsely imply portable approval.
