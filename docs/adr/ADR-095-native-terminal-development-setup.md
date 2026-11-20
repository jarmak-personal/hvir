# ADR-095: Native terminal development setup

> Lifecycle: Active

## Context

Native terminal testing should use the ordinary contributor workflow without personal
account credentials, manual artifact transfer, or an ambient library-path setting.
The full renderer and maintained bindings require preparation beyond JavaScript package
installation. Native dependency and package tooling already owns that preparation and
its provenance; app startup and terminal creation must not become compiler workflows.

## Decision

Prepare native development dependencies during the repository's npm installation
lifecycle on supported contributor hosts, using the existing pinned local native build
and binding owners. Cache completed artifacts by their maintained native input bytes,
target and installed Electron identity. Verify integrity and producer/ABI relationships
before reuse, and preserve actual producer source/development records across unrelated
application commits. Never relabel a cached artifact as a new producer.

The development launcher validates readiness and selects the prepared native library
before Electron starts. Missing or stale assets fail with an actionable repair command;
there is no silent web-engine fallback. Keep an explicit legacy development command for
comparison and diagnosis. App runtime code imports no contributor build tools and does
not download or compile native dependencies.

CI dependency installation does not duplicate the dedicated native jobs' compilation.
Explicit native preparation remains available there, and all existing native artifact,
behavior, physical hardware, performance and acceptance gates remain independently owned.
This development selection does not authorize a packaged default, legacy retirement,
release publication, signing, or final migration cutover.

## Consequences

A fresh contributor installation takes longer and needs the documented platform compiler
prerequisites and public network access. Validated matching artifacts survive repeated
npm installations in ignored package build output. Source changes require rebuilding,
and incomplete or interrupted attempts cannot establish readiness. No private artifact
service or public prerelease publication is introduced merely to enable branch testing.

## Rejected alternatives

- Manual SDK transfer or authenticated CI downloads: prevents ordinary testing on a work
  machine without personal-account access.
- Requiring contributors to orchestrate native build/binding commands and library paths:
  makes branch testing unnecessarily different from ordinary development.
- Compiling at app startup or terminal creation: adds heavy work to product lifecycles.
- Automatically publishing unqualified binaries: expands distribution authority unnecessarily.
