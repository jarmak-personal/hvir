# ADR-056: Explicit local extension authoring

> Lifecycle: Active
> Supersedes: [ADR-053](ADR-053-local-agent-workbench-access.md) | partial | Standalone CLI physical filesystem edge limited to fixed shipped reference reads, for explicit local scaffold, validate and skill export only.

## Context

A simple extension must be authorable from installed offline guidance without a checkout,
application session, package manager or build. Existing package validation and public guest
presentation already own the relevant contracts. Explicit author-selected output is a new
local effect; ordinary path-based file creation follows parents and cannot preserve that
boundary during replacement.

## Decision

One focused extension-authoring owner consumes the installed command contract, fixed maintained
guide/starter/skill assets, public guest UI and existing package capture/validation. Local CLI
dispatch wires this owner through LocalHost without starting Electron, PTYs, connectors or
activation. Static reference stays separate from authoring effects. Forwarded SSH commands
refuse authoring; no remote scaffold, grant, provider instruction or activation authority is added.

Scaffold creates the fixed inspectable clock package, validation captures ordinary directory,
ZIP or development-link input without execution, and skill inspection/export exposes exact
maintained bytes. Destinations are explicit absolute host-qualified local paths. The immediate
extension-storage adapter opens parent components without following author-selected links,
creates exclusive descriptor-relative staging entries and publishes with the existing no-replace
primitive. Ordinary root-owned macOS system aliases map to their physical roots. Known occupied
outputs are refused before staging. Replaced parents, stages or publication receipts refuse
success; uncertain partials remain for user inspection rather than path-based deletion. These
same-account file mechanics are not a claim of OS confinement against hostile native programs.

Starter code depends only on public bridge/presentation interfaces. It owns visible refresh and
idempotent subscription/timer disposal, including late initial replies after newer context.
Installed guide topics add focused tasks and examples while contract/command owners retain
schema authority. Native packages carry these fixed assets offline. A tiny optional skill is
explicitly inspected/exported and installed or removed by the user; hvir neither injects startup
instructions nor maintains installed copies. Enablement and live grants retain ordinary decisions.

## Consequences

A connector-free styled clock works independently of optional integration setup. Failed or
raced materialization can retain a uniquely named partial with an inspection instruction.
Author-created destination parent symlinks require selecting their real directory. Package
validation, trust, visibility and activation remain owned by their existing seams.

## Rejected alternatives

- A second validator, permission/action registry or general template framework.
- Path prechecks followed by link-following writes, overwrite, or recursive cleanup of uncertain files.
- Runtime network reference, author build steps or private workbench imports.
- Automatic skill installation, launch/recovery injection, or implicit extension enablement.
