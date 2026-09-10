# ADR-042: Explicit outside-project file viewing

> Lifecycle: Active
> Supersedes: [ADR-003](ADR-003-swappable-terminal-pane.md) | partial | Terminal file-link location restriction to the active workspace.
> Supersedes: [ADR-010](ADR-010-project-host-remote-boundary.md) | partial | Temporary document viewing addendum: location, document-type, and automatic image-read scope.

## Context

Agents reference sibling worktrees, agent-owned directories, and scratch files. Restricting
explicit viewing to registered roots or temporary Markdown and HTML interrupts the view-first
workflow. Automatic image reads need a narrower boundary than an explicit file activation.

## Decision

Explicit terminal file activation may view any supported regular file on the terminal's host.
Absolute paths, `file:///absolute/path`, and `file://localhost/absolute/path` retain that host;
other URI authorities fail visibly. Printing a path grants no read and triggers no read.
Explicit rendered Markdown document links follow the same rule, resolving relative paths
against the document's resolved location. The originating workspace remains the viewing context,
including targets in other registered projects or worktrees.

Main validates the active originating workspace, host identity, and canonical target using
ProjectHost. Files outside that workspace, including symlinks resolving outside it, are read-only.
Tabs expose the host, resolved location, and outside-project status. Existing formats, fallback,
source/rendered modes, navigation positions, and size bounds apply. Git, edit/save, file mutation,
registration, and ADR-030 transfer authority remain unchanged and separate.

For outside-project Markdown, automatic image reads may access only the canonical document
parent directory and descendants on the same host. Canonical image targets must remain beneath
that directory. For `/scratch/report.md`, `./chart.png` and `./assets/chart.png` are allowed;
`../private/chart.png`, other hosts, and symlinks escaping `/scratch` are denied. Existing image
formats and size limits apply. Explicit document links may open files outside this asset boundary.
HTML keeps its existing opaque sandbox, self-contained resource policy, and response-header CSP.

There is no temporary-directory exception. Outside-project tabs are ephemeral, create no watch
or polling interests, and disappear on workspace departure, host disconnect, or restart. Closing
a tab or disposing a renderer releases preview/image resources; revoked lifetimes reject late
completion. Shared data contracts remain independent of main and renderer implementations;
preload carries typed requests and IPC registrars delegate read policy to the document owner.

## Consequences

Users inspect agent output without registering folders or moving files. Explicit activation is
bounded viewing authority without an additional prompt; automatic embedded reads remain confined.
External documents neither acquire mutation authority nor expand background filesystem work.

## Rejected alternatives

- More location-specific exceptions for temporary or agent-owned directories.
- Automatic image reads anywhere on the host or per-image access prompts.
- Registering external locations or switching workspace when viewing another project's file.
- Sharing read-only viewing authority with mutation or transfer grants.
