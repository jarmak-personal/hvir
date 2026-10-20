# ADR-081: Trusted Trash review for an extension-selected project directory

> Lifecycle: Active
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Requiring an extension-selected project original to be revealed in Files before requesting its separate deletion action.
> Supersedes: [ADR-030](ADR-030-bounded-project-file-operations.md) | partial | Visible workspace selection for recoverable deletion: permit the exact registered workspace visibly identified by a trusted extension-requested Trash review.

## Context

A user who chooses Remove from project on an original skill should reach the existing
Files confirmation directly. A source read grant must not become deletion authority.
An application extension can target a registered workspace other than the active Files
pane, whose inactive viewer may still retain unsaved drafts.

## Decision

The separately declared `source.request-trash` capability requests trusted Files review
of one ordinary directory in the current main-admitted workspace. Main requires a visible
ordinary human view and its existing exact workspace read grant. It rejects agents,
actions, updaters, application sources, workspace roots, symbolic-link traversal and
non-recoverable hosts. `source.reveal` remains read-only navigation.

The request binds installation, declaration, view, renderer generation, workspace, host,
canonical root and native directory identity. One pending request is admitted application
wide. Preparation and human review expire after sixty seconds; a confirmed operation uses
Files' existing finite physical lifetime. Revocation ends pending review and prevents late
confirmation. Once a physical operation is submitted, its reservation remains until actual
settlement; cancellation or lost completion is never proof of rollback.

Trusted chrome presents the existing Files Trash dialog without navigating away from its
origin. Its exact host-qualified target is visible. Files retains dirty-buffer review,
human confirmation, progress, cancellation, bounded tree validation, ProjectHost effects and
truthful outcomes. Main revalidates the source-bound target before submission and immediately
before Trash. No guest receives a reusable authorization or a file-operation identifier.
The result reports completion only for a verified `trashed-entry` effect.

Viewer review and cleanup use the exact target workspace, including its retained or restored
tabs, rather than the unrelated active workspace. Clean tabs retire only after successful
removal; dirty buffers and uncertain outcomes remain preserved.

Local recoverable Trash is required. Unavailable or permanent-only hosts, including current
SSH hosts, refuse with an actionable reason. There is no force mode or permanent fallback.
The existing ordinary Files capabilities remain unchanged.

## Consequences

Extensions can offer one understandable file-removal decision without receiving deletion
authority. Existing Files and viewer owners retain their protections and physical work.
The request adds a bounded UI lifetime and requires explicit uncertainty handling.
Arbitrary concurrent external writers remain outside hvir's atomic control; identity and
confinement checks refuse observed changes without promising filesystem locking.

## Rejected alternatives

- A deletion flag on `source.reveal`: silently changes read-only navigation into mutation.
- Guest deletion grants or native shell commands: duplicate existing Files authority.
- Navigating to Files before review: adds work and can hide the requesting view.
- Cleaning the active viewer for every target: misses inactive dirty buffers.
- Falling back to permanent deletion: violates the recovery decision the user made.
