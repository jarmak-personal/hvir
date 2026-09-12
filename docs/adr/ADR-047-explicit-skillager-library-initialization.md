# ADR-047: Explicit Skillager personal-library initialization

> Lifecycle: Active
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Registered-project confinement only for the named local personal-library initialization and registration capability.
> Supersedes: [ADR-046](ADR-046-explicit-skillager-library-and-exposure-authority.md) | partial | Initial personal-library connection and first-use presentation only; add explicit local initialization followed by verified metadata connection.

## Context

An installed Skillager CLI without a personal library leaves first-time users unable to browse
skills. Library initialization is a bounded public CLI operation, but it creates and registers
local state outside project roots. Neither an executable probe nor the existing metadata
connection grant authorizes those effects. The personal library's Git history is distinct from
Git tracking or ignore policy for skill copies in a project.

## Decision

### One explicit initialization and connection grant

When the enabled, compatible local CLI reports no registered personal library, offer **Set up
your personal library**. Show its local location, defaulting to `~/.skillager/library` under the
selected CLI environment’s captured HOME, as selectable read-only text with a folder choice. **Keep Git history** starts enabled and can be explicitly
cleared. Explain that this choice applies to the personal library itself. Git initialization is
confined to the explicitly selected library root; being viewed as a project does not disqualify
that root. No separate active-workspace Git initialization or ignore-file changes occur, and hvir
does not decide whether exposed project copies should be tracked.

**Create and connect** grants initialization/registration of that one displayed local path and,
on a verified matching result, metadata connection to the resulting canonical library. Main
binds the request to the selected installed executable, local host, personal catalog, location,
Git choice, and renderer/request generation. Main retains the displayed default or selected
local target and returns its host-qualified location with an opaque selection identity. Submit
uses that retained selection, not a new arbitrary renderer path. A narrow Skillager native
directory picker selects the exact local directory without appending a hidden child folder;
Cancel preserves the previous choice, and stale picker completion cannot replace it. The picker
selects only: it neither creates folders nor registers projects nor borrows Files move authority.
Enabling, probing, opening the form, and choosing a
folder do not run initialization. This local-only grant applies even beside an SSH workspace;
it grants no remote initialization or general filesystem authority.

The main-owned Skillager capability executes the installed CLI's public noninteractive
`library init --path <local-library> --json`, adding `--no-git` only for an explicit unchecked
choice. Reuse the local ProjectHost execution adapter, selected personal catalog, isolated CLI
cwd/project state, finite process/output bounds, and existing renderer authority. Skillager owns
library creation, registration, any indexing, canonical identity, and Git metadata/history.
hvir neither reproduces those policies nor edits private catalog records. No terminal launch,
PTY input, package installation, or interactive `skillager setup` is part of this action.

Show progress and actual failures while the rest of the workbench remains usable. Validate the
supported initialization schema and per-operation result, canonical local identity/location,
actual Git mode, and resulting public library status before publishing success or a connection.
Successful process exit alone is insufficient. A matching initialized or already-initialized
result may connect directly, without another Check again or Connect click. Opening the library
does not approve a skill, publish instruction bodies or scanner excerpts to the renderer, or
expose anything to a workspace. CLI-internal indexing remains Skillager-owned; main allowlists
result metadata before IPC.

A concurrent or existing registration cannot silently retarget the confirmed path or identity.
Skillager may preserve an existing library's Git mode instead of applying the requested mode;
show the actual mode and return to an explicit connection choice when they differ. Do not claim
to have changed history mode, silently retry without Git, convert a library, overwrite existing
registration, or automatically adopt a different library.

### Cancellation and recovery

Revocation cancels pending execution and rejects late completion, UI restoration, and metadata
connection. This includes disable, renderer replacement, changed executable/selection, and the
existing owning lifecycle boundaries. Initialization may already have created library files or
registration when cancellation, timeout, an error, or an invalid response is observed. Preserve
that distinction from a known pre-execution refusal; never report no effect without evidence.
Never delete a user's library as cancellation cleanup.

After a possibly submitted operation without a verified result, require an explicit public
status/probe reconciliation before another initialization attempt. Show the observed existing
library and its actual Git mode for explicit connection, or the actual absent/unavailable result.
Unavailability remains unresolved; it does not enable a blind retry. Re-enabling does not resume
initialization, connect, reopen a feature viewer, or acquire periodic demand. Disabled surfaces
still disappear completely apart from the Settings enable toggle.

### First-skill guidance and connection details

A successfully observed empty personal inventory shows a concise next step: a selectable or
copyable agent prompt or public CLI instruction to create a useful first skill in the displayed
library. The guidance leaves new content pending for explicit review and acceptance through the
existing workflow, followed by separately confirmed workspace exposure. The user's agent or
terminal owns authoring; hvir adds no skill editor, import UI, automatic acceptance, shell launch,
or prompt injection. Search with no matches and inventory failures retain their own truthful
states instead of pretending the personal library is empty.

Setup and connection actions take priority in the sidebar. The full resolved executable and
version remain accessible in visible connection details or enabled Settings. Missing CLI and
unsupported-contract remediation stay user-managed under ADR-046. All unaffected authority,
content-review, exposure, host qualification, cancellation, process, and disabled-state rules
from ADR-046 remain in force.

## Consequences

First-time users can initialize a library and reach metadata browsing through one deliberate
action while retaining a clear distinction between personal history and project files. Existing
public CLI contracts own the effects; hvir must validate actual outcomes and represent partial
or uncertain completion. Some failures require a read-only reconciliation and a fresh user
choice instead of an automatic retry. First-skill guidance remains usable with existing agents
without creating a second authoring surface.

## Rejected alternatives

- A mandatory shell handoff adds friction to a bounded noninteractive operation and needlessly
  grants terminal execution for initial setup.
- Initialization on enable or probe conflates discovery with filesystem/catalog mutation.
- Automatically disabling Git after failure hides the user's choice; changing project Git or
  ignore files conflates personal-library history with workspace deployment policy.
- Installing Skillager or bootstrapping Python/uv expands the accepted user-managed dependency
  boundary. Interactive setup also carries unrelated router and workspace-installation scope.
- Treating canceled execution as no effect, deleting the resulting library, or retrying blindly
  risks user files and registration. Public status is the reconciliation authority.
