# ADR-021: Platform-native installation from immutable GitHub Releases

## Context

ADR-011 selected npm as hvir's installation, update, removal, integrity, and provenance
authority. ADR-018 retained that authority while moving native payload preparation into a
script-free per-user cache.

That contract cannot safely provide the system integration Chromium requires on Ubuntu 24.04.
The npm payload and its prepared cache are user-owned, so they cannot install the root-owned
executable and AppArmor policy needed to preserve Chromium's production sandbox. Treating native
installers as an additional distribution surface would leave hvir with competing platform,
version, trust, update, and removal contracts.

This record supersedes ADR-011 and ADR-018. Those records remain the history of the npm
distribution design.

## Decision

### Public surface and release authority

hvir has one supported user-facing installation surface:

```sh
curl -fsSL https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh | bash
```

The fetched asset is release-specific rather than a mutable installer from the default branch.
It selects one supported platform and architecture, downloads one exact native artifact from the
same GitHub Release, verifies that artifact against a SHA-256 digest embedded in the installer,
and only then invokes the native installation operation. Direct installation of a native
artifact is not a supported user workflow; the artifacts remain installer payloads and
verification evidence.

One published, immutable GitHub Release is the authority for one exact version. Its tag, source
commit, installer, release manifest, third-party notices, and all native artifacts describe the
same version. The manifest binds the version, tag, source commit, supported architectures,
artifact names, SHA-256 digests, and notices. A public installer is not published until every
required native artifact has passed its target acceptance. After publication, the tag and assets
are not replaced; a correction requires a new version and release.

GitHub HTTPS plus that immutable release is the bootstrap trust root. The installer's embedded
digest is the mandatory artifact check and happens before elevation. GitHub's generated release
attestation is an independent audit path for the release tag, source commit, and assets; it is
not a clean-install prerequisite. Installation requires no GitHub CLI, Node.js, npm, `cosign`,
or hvir-specific verifier.

### Supported native packages

The supported matrix is:

| Platform | Architecture | Native artifact | Support baseline |
| --- | --- | --- | --- |
| Linux | x64 | `.deb` | Ubuntu 24.04 LTS |
| Linux | arm64 | `.deb` | Ubuntu 24.04 LTS |
| macOS | Apple silicon (`arm64`) | flat `.pkg` | modern macOS |

Other Debian-family systems are not claimed as supported until the same native installation
acceptance passes. Intel macOS, Windows, and other native package formats remain unsupported.

On Linux, the installer downloads the matching `.deb` without elevation and delegates the exact
package installation or update to `apt`. The package owns the root-installed application,
command, and Ubuntu AppArmor lifecycle needed to launch Chromium with its process sandbox
enabled. Package removal unloads and removes package-owned AppArmor state.

On macOS, the application has a Developer ID Application signature. A Developer ID Installer
signature covers the flat package, Apple notarizes it, and the released package carries a
stapled ticket. The package owns `/Applications/hvir.app` and `/usr/local/bin/hvir`. After
verification, the installer invokes the package noninteractively through
`/usr/sbin/installer`; the supported path does not open Finder or Installer.app.

The installer starts without elevation. It requests elevation only for the exact native package
installation, update, or package-owned removal operation. Artifact selection, download, digest
verification, and migration discovery remain unprivileged.

### Command, update, removal, and migration lifecycle

The installed `hvir` command accepts an optional positional local project path on both
platforms, so `hvir .` opens the current directory. The native packages own that command;
the npm launcher and per-user prepared payload cache are no longer runtime dependencies.

The same release installer contract exposes install, update, uninstall, and explicit purge
modes:

- Install and update delegate ownership to the native package manager. Success exposes one
  complete version. A failed operation reports its stage and either leaves the previous
  installation working or reports a recoverable native package-manager state; it must not
  report or expose a launchable partial version as success.
- Default uninstall removes only package-owned application, command, and system-integration
  files. It preserves Electron settings, registered-project metadata, project directories, and
  all other user-authored data.
- Purge requires explicit user intent and removes only the documented hvir-owned user-state
  roots in addition to package-owned files. Project directories and other user-authored data
  are never purge targets.

npm remains available during the migration and stops publishing only after the complete native
replacement and migration paths pass cumulative acceptance. A successful native installation
may remove a legacy `hvir` launcher only after proving that it belongs to `hvir-workbench`; it
must not remove an ambiguous or unrelated command. Only after native installation succeeds may
migration remove hvir's derived npm native cache. Published npm packages are then deprecated,
not unpublished.

Updates are explicit installer invocations. hvir does not add an in-application updater, hosted
update service, background update authority, or second supported installation path.

## Consequences

hvir gains platform-native ownership for Chromium sandbox policy, macOS signing, commands,
updates, and removal while retaining one documented user workflow. GitHub Releases become the
single version, artifact, checksum, notices, and provenance boundary. Users need network access
to GitHub and must approve only the bounded native package operation that needs system
privileges.

Release construction is more demanding: Linux packages must be built and accepted on both
architectures, the macOS package requires protected signing and notarization credentials, and
publication must remain atomic across all assets. Direct package-manager installation may work
mechanically, but it is outside the supported workflow because it bypasses installer-owned
selection, digest verification, migration, and lifecycle behavior.

## Rejected alternatives

- Retaining npm for Linux while adding a macOS package, or retaining npm for macOS while adding
  Linux packages; either creates competing lifecycle and support contracts.
- Offering direct `.deb`, `.pkg`, DMG, ZIP, AppImage, Finder, Installer.app, drag-and-drop,
  Homebrew, Snap, Flatpak, RPM, Pacman, Mac App Store, or Windows installation paths.
- Disabling Chromium sandboxing, asking users to change AppArmor or sysctl policy, or requiring
  manual ownership and permission repair.
- Elevating before artifact selection and digest verification.
- Requiring GitHub CLI, Node.js, npm, `cosign`, or a project-specific verifier for a clean
  installation.
- Mutating a published tag or release asset to recover a failed release; a new version preserves
  immutable provenance.
- Adding an in-application updater, background agent, hosted update service, or general installer
  framework.
