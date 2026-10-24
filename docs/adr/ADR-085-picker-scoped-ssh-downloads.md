# ADR-085: Picker-scoped local destinations for SSH downloads

> Lifecycle: Active

## Context

ADR-030 defines external-source grants and a verified transfer pipeline, but does not
supply local write authority for retrieving files from an SSH workspace. Outside-project
viewing under ADR-045 supplies no transfer authority. A download needs an explicit local
destination without granting the renderer ambient filesystem access.

## Decision

The Files feature offers Download for a selected regular file or folder strictly inside a
registered SSH workspace. Main snapshots the exact source, workspace, host, renderer owner,
and generation before opening a native local directory picker. Selecting the directory is
explicit approval to perform that download immediately; no additional confirmation is shown.
Cancelling the picker has no transfer effect.

The main-owned project-file operation coordinator acquires private, single-operation authority
for the exact picker-selected canonical local directory. That directory may be inside a
registered local project. The renderer neither supplies the destination path nor receives a
reusable destination grant. Selection and focus changes cannot retarget the operation.

The coordinator uses host-qualified ProjectHost ports and ADR-030's existing bounded streaming,
metadata normalization, verification, staging, no-replace publication, conflict policy, and
operation limits. The remote source is retained. Source traversal rejects symbolic links;
destination traversal cannot escape the selected canonical directory. Main revalidates the
destination before publication. Existing entries are neither overwritten nor merged.

The destination grant is bound to the operation's renderer owner/generation, workspace, and
SSH host lifetime. Completion, cancellation, renderer revocation, workspace or project closure,
host replacement or disconnect, deadline, and shutdown revoke remaining publication authority.
A reconnect does not restart a transfer. Only cleanup of exact operation-created staging entries
may outlive revocation; cleanup must still prove its destination confinement. No prefix-based
scavenging or persistent destination access is introduced.

Files owns selection, the Download control, accessible progress, cancellation, and final results.
An Electron adapter owns native picker access; IPC validates and delegates; bootstrap composes.
Shared contracts remain independent of main and renderer implementations. Clipboard paste and
external drop remain copy operations with ADR-030's existing target and source-grant rules.

## Consequences

Users retrieve agent output directly to a chosen local directory with one explicit approval.
The existing transfer owner keeps upload and download semantics consistent. Repeated downloads
require another picker choice; there is no remembered write grant. Inaccessible or changed
destinations fail visibly. Cleanup cannot promise removal after application exit or loss of
access, and must retain rather than follow an unprovable destination.

## Rejected alternatives

- Renderer-supplied paths or reusable folder tokens would enlarge authority beyond one gesture.
- A second confirmation after native selection duplicates the user's explicit approval.
- Excluding registered local projects adds a surprising restriction without narrowing the
  explicitly selected operation's authority.
- A fixed Downloads directory fails the explicit destination-choice requirement.
- A separate transfer engine would duplicate ADR-030's policy and lifecycle ownership.
