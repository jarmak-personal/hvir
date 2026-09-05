# ADR-029: Distinct signed macOS SSH acceptance channel

> Lifecycle: Active

## Context

macOS Local Network Privacy attributes network access using code identity that includes the code
signature and main-executable UUID. A raw Electron development process, an ad-hoc packaged copy,
and the installed hvir release can share ambiguous identity while carrying different signatures.
Launching those copies together can make LAN SSH unavailable to hvir even though the target
remains reachable by other applications.

Contributor copies also derived every durable owner from Electron's default user-data path. A
locally packaged copy using the release name could therefore share project registration,
known-host decisions, terminal recovery, harness profiles, and diagnostics with the installed
release.

## Decision

The installed release remains the only supported user installation and retains bundle identity
`dev.hvir.app`, release signing, notarization, package ownership, and its existing user-data root.

hvir provides one contributor-only macOS LAN SSH acceptance channel. It is a complete packaged
application with the distinct bundle identity `dev.hvir.ssh-acceptance`, an explicit Local Network
usage description, and an Apple-issued Developer ID Application signature. Its build and launch
path fails closed when the required signing inputs are unavailable; it never substitutes raw
Electron or an ad-hoc signature. The acceptance bundle is not installed, notarized, published, or
updated as a second product.

Build channel is a compiled application fact rather than a runtime environment choice. Before any
storage owner is constructed, the SSH acceptance channel selects the dedicated hvir-owned
`hvir-ssh-acceptance` directory under the platform application-data root. Release, ordinary raw
development, and smoke channels retain their existing roots. Project registration, known-host
decisions, terminal recovery, harness profiles, diagnostic journals, and temporary reports all
receive the selected root.

Bounded diagnostic reports include the closed build-channel value so concurrent reports identify
their own application channel without recording paths, hosts, credentials, terminal content, or
arbitrary environment data.

## Consequences

Contributors gain a stable, separately permissioned identity for clean-state macOS LAN SSH
coexistence testing without changing `SshHost` or creating another installation surface. The
release and acceptance copies cannot mutate each other's durable hvir state.

The acceptance path requires protected Apple signing material and a clean or restorable macOS
Local Network permission state. Ordinary hot reload remains faster and unchanged, but cannot
serve as LAN SSH acceptance evidence. Electron applications may still share a main-executable
UUID, so signature inspection alone does not replace coexistence testing in both launch orders.

## Rejected alternatives

- Reusing `dev.hvir.app`, the release user-data root, raw Electron, or an ad-hoc signature for SSH
  acceptance; each preserves the ambiguous identity or shared-state failure.
- Installing or publishing a second development product, package, updater, daemon, helper, or
  service; contributor acceptance does not create another user surface.
- Changing SSH transport, authentication, pooling, or retry behavior; the observed denial occurs
  before the remote host receives a packet.
- Selecting build channel or user-data authority from an ambient runtime environment variable;
  mutable launch input could silently collapse the isolation boundary.
