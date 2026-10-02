# ADR-047: Local SSH configuration authority

> Lifecycle: Active

## Context

Opening a remote project requires an SSH alias. Requiring users to leave hvir to add one
interrupts that flow, and startup-only discovery hides external additions until restart.
General project-file authority does not authorize editing a user's SSH configuration.

## Decision

The main-owned SSH configuration capability may add one validated named host to the local
`~/.ssh/config` selected by main. The renderer supplies alias, hostname, username, port,
and an optional local identity-file path through typed, owner-qualified IPC. It cannot
supply a destination, arbitrary config text, directives, or remote configuration paths.
A native local file picker selects an optional identity; authentication remains owned by SSH.

All local reads and writes pass through host-qualified LocalHost operations. Reads are bounded.
Saving preserves existing text and puts the new exact host before wildcard defaults so its
explicit connection fields take precedence. Current-file duplicate validation and optimistic
version checks reject observed external changes; absent files are published without replacement.
New SSH directories and config files use private permissions. Discovery follows symlinked configs;
saves reject nonregular config entries rather than replacing them or their targets. This authority
does not expand general project-file editing.

ProjectHostCatalog retains discovery and logical-host lifetime ownership. Chooser activation
and window focus request fresh discovery. Failed refresh retains the last usable list and
reports an error. Refresh does not replace or disconnect materialized hosts, PTYs, trust, or
authentication owners. Their existing connection settings remain pinned to their lifetimes.

Saving does not connect. The chooser selects the saved alias and leaves Connect as a separate
user action. Renderer request generations reject delivery after dismissal or supersession;
the chooser owns and cancels its temporary success-feedback timer.

## Consequences

SSH config remains the durable source of truth. Existing host behavior and live resources
survive refresh. Optimistic checks detect observed conflicts, without claiming an OS-level
compare-and-swap against arbitrary external writers. Large configurations require external
maintenance; symlinked configurations remain discoverable but require external editing. Discovery
retains the existing parser's supported directive scope.

## Rejected alternatives

- A separate hvir host store, which duplicates SSH configuration authority.
- Arbitrary renderer-supplied config text or destinations, which widen write authority.
- Rebuilding live SSH hosts on refresh, which would disrupt active work.
- Connecting during save, which makes configuration depend on remote availability.
- A general configuration editor, key generator, or credential store.
