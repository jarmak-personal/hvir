# ADR-079: Selected-original Save and accept

> Lifecycle: Partially superseded
> Superseded by: [ADR-083](ADR-083-project-batch-save-and-accept.md) | partial | Limiting standalone Save and accept to one selected project original.
> Superseded by: [ADR-082](ADR-082-selected-original-save-and-use.md) | partial | Mandatory separate replacement decision when the human explicitly chooses the combined Save and use task.
> Supersedes: [ADR-059](ADR-059-public-local-skillager-management.md) | partial | Local management excludes selected external import; complete exact external inspection and one human Save and accept decision are permitted.

## Context

A selected project original can be useful in a personal library while its project files
remain independently owned. Skillager's public import both copies and accepts the exact
source version. Ordinary current-file reading and a library acceptance manifest cannot
establish the external tree or import destination being accepted.

## Decision

Offer one human-only Save and accept action for the selected local project original.
The extension consumes the public external import manifest with the exact discovered
source ID and canonical instruction-file path, source provenance/hash, complete file
identities, destination/name, library identity/history, and opaque confirmation token.
All files remain available for optional inspection through existing confined source grants;
there is no mandatory visit checklist. Library acceptance and external import remain distinct
public contracts, sharing only complete file identity validation and presentation.

A fresh complete manifest/token must match the decision before dispatch. The action rechecks
the same public contract and uses ordinary structured import argv through the independently
approved project connector. Skillager owns discovery, tree capture, scanner/lint gates,
collisions, history, copying and acceptance. No override, force or implicit replacement is
added. Any first-import default-library initialization is a visible effect at the CLI-reported
location and history mode. No library is initialized by selection or preview.

The original remains untouched. Save and accept creates a separate accepted canonical copy;
subsequent replacement or adoption belongs to the existing advanced-exposure decision.
Public search may link an original to a canonical version without making it a managed copy.
Keep its canonical actions and offer original import as a contextual choice in the same task
area; the link grants no replacement authority.

Public imported metadata and fresh accepted status must agree before reporting success.
Lost, failed or malformed completion can leave copied or committed pending content. Keep the
exact operation and admitted raw output for explicit current-state reconciliation, without
retry or rollback claims. Current state never proves the original operation's completion. A fresh exact public import
preview can positively establish an absent destination. No registration establishes only that
current fact, leaving destination and partial files unknown. Explicit acknowledgment releases
the specific operation; every later attempt requires a new public preflight and decision.

## Consequences

The everyday flow requires one trust decision and makes the complete external version
inspectable. Unsupported CLI contracts require an update or public CLI workflow. User-owned
originals retain their identity, while collisions require a separate destination decision.
First-use effects and uncertain partial effects must remain visible.

## Rejected alternatives

- A pending-copy finalization step adds a second everyday decision without changing the
  public import semantics.
- Relabeling a library manifest as external-source evidence loses source and destination binding.
- Agent acceptance, automatic import, or replacing the original conflates independent authority.
- Recreating Skillager's tree/scanner or preservation policy creates a second domain owner.
