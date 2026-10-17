# ADR-062: Exact-source extension release artifacts

> Lifecycle: Active

## Context

An ordinary extension must be downloadable without a checkout or build step. Native release
assembly already owns exact source, complete assets, checksums and immutable publication.
The first released public contract also needs independent reference inputs that later starter
changes cannot silently rewrite.

## Decision

Build `hvir-skillager-<application-version>.zip` from the selected release checkout through the
maintained Skillager package entrypoint. Include the root manifest, ready-to-run UI, captured
public presentation assets and user documentation; exclude source/build inputs and the separately
installed Skillager executable. Use the existing yazl dependency with ordered files, fixed
timestamps and ordinary file modes. Ordinary package capture and manifest validation retain
their authority; the release introduces no runtime ZIP authoring API or privileged fallback.

The existing native release assembler records the extension's package ID, package version,
public contract, asset name and digest in its release manifest. The application version and
source commit remain release-wide facts. Extend the same checksum, exact asset and immutable
publication paths. The installer still selects native application payloads only; an extension
ZIP is not an application installation format. Existing version preparation, signing,
notarization and native acceptance owners remain unchanged.

Freeze independent reference and clock package bytes for application release 0.3.0 and public
contract 1.0 under versioned test fixtures, with a complete file digest inventory. Current
authoring templates and public UI assets continue to evolve under their maintained owners;
their build entrypoints never rewrite released fixtures. Normal verification captures these
inputs through the ordinary package boundary and retains capability, grant and lifecycle
coverage. Newer-minor examples can use available capabilities, while missing required safety
semantics refuse before execution. No pre-release compatibility shim is introduced.

Native package inspection and installed offline command probes consume the maintained guides,
starter, public UI, optional skill and four remote clients. User walkthroughs use ordinary
installation, access and revision controls. Instruction skill setup remains explicit; neither
startup injection nor automatic tool installation follows from shipping these assets. Available
automated evidence and environment-dependent installed/real-host evidence describe their actual
boundaries rather than replacing one another.

## Consequences

One immutable release binds native applications and the ordinary extension to the same source.
Users can inspect and install the ZIP independently, and released compatibility inputs stay
stable as authoring guidance changes. Release preparation must validate the additional complete
asset and retain the existing signing and host-specific acceptance requirements.

## Rejected alternatives

- A separate extension publisher, mutable-source download or untracked release upload.
- Bundling Skillager, automatically installing tools, or reinstating a built-in integration.
- Rebuilding released fixtures from current starters or adding legacy pre-release readers.
- A second installer, authoring runtime or certification/readiness framework.
