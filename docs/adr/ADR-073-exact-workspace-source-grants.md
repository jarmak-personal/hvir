# ADR-073: Exact workspace source grants and contextual read requests

> Lifecycle: Active
> Supersedes: [ADR-057](ADR-057-selected-extension-source-reading.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.
> Supersedes: [ADR-068](ADR-068-in-context-human-source-read-decisions.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.

## Context

A person reading skills across projects needs independent remembered read permissions.
One grant per declaration replaces project A when project B is approved, and Settings-only
workspace consent interrupts the selected reader. Application views can already have an
explicit, main-admitted workspace target.

## Decision

The existing source approval owner retains read-only workspace grants by installation, full
declaration, workspace identity, and exact host-qualified canonical root. Application sources
retain their existing single-root replacement and ancestor coverage rules. Managed-delivery
grants retain their single binding and Settings decision: approving workspace B replaces and
revokes workspace A's delivery authority. Across an accepted declaration context change, an
application approval replaces prior same-source workspace bindings; a read-only workspace
approval replaces a prior application or delivery binding. Read-only workspace approvals retain
other exact workspace bindings. Registration, host, declaration and activation checks remain
live; retaining a grant does not make an unavailable binding usable.

An ordinary visible human reader may request a read-only workspace source using only its
source identifier. Main derives the root and identity from the caller's admitted context,
including an explicitly targeted application view. Guest-supplied roots and workspace IDs are
refused. Existing source request transport owns the finite decision, trusted chrome, and
cancellation. Native executable access, agents, actions, and updaters confer no body authority.

The source owner exposes a narrow prepared workspace read decision to trusted coordinators.
It carries activation, exact context, current/abort checks and cancellation through persistence;
a reusable grant must still be current before a coordinator writes any independent decision.
Coordinators never write the source store or infer consent from native permission.
Callers must keep the handle live through all independent writes, then call `cancel()` in a
`finally` block after every outcome, including reuse, success and failure. Cancellation releases
the prepared decision and abort listener without retiring an already stored grant.

Guest status reports only the caller's binding. Settings lists retained bindings, including
unavailable ones, and may revoke one exact binding without ending another workspace's reads
or decisions. Source-wide and installation revocation remain available to lifecycle owners.
The existing 128-grant, 128 KiB store and four prepared decision bounds remain finite. Capacity
failure does not evict grants. Failed or canceled persistence never reports optimistic success
or claims rollback of an already completed physical write.

## Consequences

Returning to an unchanged approved workspace reuses its grant. Context retargeting, root or
declaration changes, revocation, expiry and disposal still reject late reads and decisions.
The existing reader continues canonical confinement, selected-file receipts and byte bounds.
Settings must distinguish retained scope from currently usable permission.

## Rejected alternatives

A project-wide wildcard would authorize unselected worktrees. A guest workspace catalog or
root argument would let an extension choose its own authority. Replacing the prior workspace
would retain repeated consent friction. A second grant store or combined native/body permission
would duplicate ownership and weaken the independent decisions.
