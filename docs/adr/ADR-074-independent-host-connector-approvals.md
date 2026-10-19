# ADR-074: Independent host connector approvals

> Lifecycle: Active
> Supersedes: [ADR-070](ADR-070-explicit-local-workspace-program-connection.md) | partial | Single saved host binding per connector and disclosure of replacing another host during local connection only.

## Context

An installed extension can serve local and SSH workspaces at the same time. Replacing
one host's native approval when connecting another prevents those workspaces from using
the same declared connector independently.

## Decision

Retain native approvals by installation, connector and exact host in the existing bounded
approval store and writer. Workspace connectors may retain multiple independently approved
hosts. Application connectors remain local. Each binding still pins the exact declaration,
canonical executable and configuration; it grants host-account access, not folder confinement.

Preparation and consent compare only the selected host's prior binding. Replacement or
revocation ends only that binding's pending decisions, admissions, executions and receipts.
Installation teardown still revokes all hosts. Ordinary local Connect adds or replaces only
the local binding; declining leaves all saved bindings unchanged. No host fallback, borrowed
approval, remote discovery or new authentication path is introduced.

Public connector status accepts an optional workspace identity admitted through the same
caller context as execution. It returns one row per declaration: local for application
connectors and the exact admitted host for workspace connectors. Missing workspace context
makes workspace status unavailable. Guests cannot select a host independently or enumerate
saved bindings. Trusted Settings lists saved hosts compactly and edits one selected host's
configuration at a time, with exact per-host revoke.

The durable store keeps its 256-record and 256-KiB bounds. Admission rejects an oversized
complete next state before replacing authority. Public status retains the eight-declaration
bound and complete response envelope; it never expands into a connector/host cross-product.

## Consequences

One extension can serve independently approved local and remote workspaces without approval
churn. Callers must select the admitted workspace when observing workspace connector status.
Host removal, disconnect and declaration changes cannot transfer authority to another binding.

## Rejected alternatives

- One saved host per connector prevents simultaneous local and SSH use.
- Automatically borrowing a local or first saved approval loses exact-host authority.
- Returning every saved host to guests expands metadata without a bounded contextual need.
- Separate stores or per-folder native grants duplicate existing ownership and imply confinement.
