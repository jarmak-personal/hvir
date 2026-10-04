# ADR-061: Explicit managed extension delivery

> Lifecycle: Active
> Supersedes: [ADR-030](ADR-030-bounded-project-file-operations.md) | partial | External source acquisition and no-replacement rules only for explicitly granted managed extension delivery; ordinary Files remains unchanged.

## Context

An approved local tool can export a complete payload for an SSH workspace without a
remote service. Native execution alone grants no source or destination access. Updating
files that hvir previously delivered requires durable authority distinct from matching
bytes, extension domain records, and ordinary Files transfers.

## Decision

Settings grants two separately declared scopes through the existing source-grant owner:
an application-local `delivery-source` export directory and one exact registered SSH
workspace with `managed-delivery` access. These modes confer no selected instruction-body
reading authority. Unchanged declarations survive explicit package revision acceptance;
workspace, host, grant, installation and admitted caller lifetimes remain qualified.

The main-owned managed-delivery owner captures a bounded, complete tree beneath the exact
source grant after a caller-bound successful native connector receipt. Capture receipts
pin current bytes and POSIX permission modes, not tool approval. The extension interprets
the public export's approval, opaque library identity, agent, source version and complete
file manifest, and compares every file with the captured manifest before requesting delivery.
Core imports no tool schema, approval hashing or deployment policy. Domain records use
separate installation-scoped bounded persistence with revision checks and cannot edit delivery authority. Generic fingerprints use deterministic ordinal path ordering, independent of process locale.

One private delivery journal under D2's serialized state-write lease binds installation,
caller, host, exact workspace, source-version descriptor, target, complete previous and
intended fingerprints, operation identity, exact staging and preservation locations, and any disclosed supporting parents with their known or unknown creation identities.
Supporting parents use exclusive creation inside the destination grant and remain shared user data; cleanup never removes them. Durable intent precedes every remote mutation. A failed intent save performs no remote
effect. Journal saves serialize under the existing state lease; physical work reserves the exact host-qualified destination and allows bounded unrelated work. Physical reservations survive revocation until pending host calls settle. Remaining
work aborts on disconnect, grant or caller loss; reconnect inspects recorded objects and
never automatically replays publication.

Add publishes only to an absent target. Update and Remove require the exact completed
delivery record, stable directory identity and unchanged complete tree. New content stages
and verifies before Update displaces the old tree. Displacement preserves old data in a
workspace-level `.hvir-delivery-retained` directory outside active skill discovery. All
renames use ProjectHost's no-replace primitive. A foreign or changed placement retains
staging and displaced content with exact locations; no force or destructive rollback exists.

ProjectHost supplies narrow managed-transfer primitives for exact ordinary POSIX file
permissions and stable directory identity. Local uses device/inode/birthtime; SSH uses the target's
native Linux or macOS `stat` command with creation time through finite exec, without installing a helper.
Unsupported identity observation refuses managed mutation. Recorded identity plus complete
tree verification supplies recovery custody; a matching hash alone cannot adopt a target.
Comparisons and renames do not promise exclusion of arbitrary external writers or atomic
compare-and-replace across hosts. Changed displacement or publication remains a conflict.

Capture, tree walking, records, retained objects, concurrency and deadlines have finite
limits. Current completed authority is distinct from retained history: completed operations without retained objects release history capacity, and only possible retained payloads remain charged. Domain compaction uses a complete revision-bound core observation and preserves pending uncertainty and metadata needed by retained previous versions. Cleanup is an explicit bounded operation on exact recorded unchanged identities
and fingerprints; it never scavenges names or removes uncertain content to admit new work.
Unreachable or changed leftovers retain evidence and can be inspected and resolved through
Files before explicit reconciliation. Trusted Settings also offers fresh-facts-bound keeping of every exact object and ending tracking without cleanup, adoption or a claim of previously unproven completion. This remains available after installation identity removal. Cleanup does not execute a skill or certify its runtime.

Settings keeps completed-delivery authority by default with the existing saved-setup choice.
Explicit forgetting reads the current journal under the existing state lease and publishes authority removal only after successful persistence; unreadable evidence cannot become an empty journal. It removes completed authority and extension domain records while delivered
files remain user data. Unresolved operation evidence survives installation-identity removal
until deliberate recovery. Disable, package deletion, replacement, reload and local CLI
upgrades never remove deliveries. A reappearing package still requires the ordinary revision
action before execution.

## Consequences

Local library reading remains usable during remote failure. Delivery exposes distinct
refused, completed, conflicted and uncertain outcomes and achievable exact-object recovery.
Exact modes and native identity require focused adapter evidence. Retention can refuse new
work rather than discard data. Core mechanical custody does not prove domain approval.

## Rejected alternatives

- Reusing human source-body receipts for agent export capture would erase their origin boundary.
- Caller hashes, paths, domain records or identical foreign bytes cannot create managed authority.
- Remote marker files, installed helpers, remote Skillager and generic transactions add owners.
- Ordinary Files overwrite, name-based scavenging and automatic replay risk user data.
