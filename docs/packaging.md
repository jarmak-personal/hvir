# Packaging and GitHub Releases

hvir has one supported installation path:

```sh
curl -fsSL https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh | bash
```

To inspect the exact release-owned installer before running it:

```sh
curl -fsSLO https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh
less install.sh
bash install.sh
```

The release-owned installer selects and verifies the native package for the current supported
platform. Native packages are installer payloads and release evidence, not separate supported
installation methods. [ADR-021](adr/ADR-021-platform-native-github-release-installation.md) owns
the durable distribution, trust, privilege, update, removal, and migration boundaries.

## Supported targets

| Platform | Architecture | Artifact | Native installation |
| --- | --- | --- | --- |
| Ubuntu 24.04 LTS | x64 | `.deb` | `apt` |
| Ubuntu 24.04 LTS | arm64 | `.deb` | `apt` |
| modern macOS | Apple silicon (`arm64`) | flat `.pkg` | `/usr/sbin/installer` |

Other Debian-family systems are not supported until they pass the same native acceptance as the
Ubuntu 24.04 baseline. Intel macOS, Windows, direct package installation, DMG, ZIP, AppImage,
Homebrew, Snap, Flatpak, and other package formats are not release targets.

The installed package owns the `hvir` command. Pass a local project directory to open it
directly:

```sh
hvir .
```

`hvir [project]` accepts one local directory. Relative paths resolve from the caller's current
directory; an invalid path fails before Electron starts. Running `hvir` without a project
preserves the remembered-workspace behavior. Startup errors remain attached to the invoking
terminal.

## Installer and trust contract

`releases/latest/download/install.sh` resolves to an installer stored with a specific immutable
GitHub Release. That installer:

1. Detects one supported operating system and architecture without elevation.
2. Selects one exact artifact from the same release.
3. Downloads it over GitHub HTTPS.
4. Verifies its SHA-256 digest against the release-specific digest embedded in the installer.
5. Invokes only the exact native package operation that requires elevation.

The installer never executes an unverified native package. A clean installation requires Bash
and the platform's native package tools; it does not require GitHub CLI, Node.js, npm, `cosign`,
or an hvir-specific verifier.

GitHub HTTPS and the immutable release are the bootstrap trust root. GitHub's generated release
attestation is an additional audit path, not a prerequisite for installation. Maintainers and
auditors can independently verify the published release and assets with `gh release verify` and
`gh release verify-asset`.

## Native package ownership

### Linux

The installer downloads the matching x64 or arm64 `.deb`, verifies it, and asks `apt` to perform
the installation or update. The package installs hvir into a root-owned system location and owns
the Ubuntu AppArmor profile required for Chromium sandboxing. Its package lifecycle loads,
updates, unloads, and removes that policy. Production launch never adds `--no-sandbox` and does
not require a user to edit AppArmor, change a sysctl, or repair ownership or permissions.

### macOS

The Apple-silicon application is signed with a Developer ID Application identity. A Developer ID
Installer identity signs the flat `.pkg`; Apple notarizes the package, and the released artifact
carries a stapled ticket. The package owns:

- `/Applications/hvir.app`
- `/usr/local/bin/hvir`

After digest verification, the installer asks `/usr/sbin/installer` to install the package
noninteractively. The supported flow does not open Finder or Installer.app.

Pull-request CI builds and exercises the unsigned package structure without receiving signing
credentials. Signed package production is a manually dispatched workflow restricted to the exact
tip commit of the selected branch and the protected `native-release-signing` environment.
Configure that environment with required reviewer and deployment-branch protection. Permit an
epic branch only while its signed candidate is under maintainer acceptance; keep the default
branch permitted for release. Configure these environment secrets:

- `MACOS_APPLICATION_CERTIFICATE` and `MACOS_APPLICATION_CERTIFICATE_PASSWORD`: the
  electron-builder-compatible Developer ID Application certificate and password.
- `MACOS_INSTALLER_CERTIFICATE` and `MACOS_INSTALLER_CERTIFICATE_PASSWORD`: the
  electron-builder-compatible Developer ID Installer certificate and password.
- `MACOS_NOTARY_KEY`, `MACOS_NOTARY_KEY_ID`, and `MACOS_NOTARY_ISSUER_ID`: the App Store Connect
  API private key, key ID, and issuer ID used by `notarytool`.
- `MACOS_TEAM_ID`: the expected Apple Developer team identifier checked during installed-package
  acceptance.

The protected workflow refuses tags, stale branch tips, and mismatched source commits. It signs the
hardened application and installer, notarizes and staples the package, validates both identities
and Gatekeeper acceptance, and uploads the package only after native install, update, launch, and
removal acceptance passes.

## Install, update, uninstall, and purge

Run the same release installer for a clean install or an update. Native package managers replace
the installed version. An unsuccessful operation reports the failed stage and either retains the
previous working installation or leaves an explicitly recoverable native package-manager state;
it never reports a launchable partial version as success.

The installer also owns explicit uninstall and purge modes. Default uninstall removes
package-owned application, command, and system-integration files while preserving:

- application settings;
- registered-project metadata;
- local and remote project directories; and
- all other user-authored data.

Run default uninstall with:

```sh
curl -fsSL https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh |
  bash -s -- --uninstall
```

Purge requires explicit intent:

```sh
curl -fsSL https://github.com/jarmak-personal/hvir/releases/latest/download/install.sh |
  bash -s -- --uninstall --purge
```

After package removal succeeds, purge reports and removes only these current-user roots:

| Platform | Settings | Cache |
| --- | --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/hvir` | `${XDG_CACHE_HOME:-~/.cache}/hvir` |
| macOS | `~/Library/Application Support/hvir` | `~/Library/Caches/hvir` |

The paths in the Linux row use an absolute `XDG_CONFIG_HOME` or `XDG_CACHE_HOME` when set and
otherwise use the shown home-directory fallback. Purge never deletes a registered local or
remote project directory.

During migration, native installation completes before legacy state is removed. The installer
removes an existing npm `hvir` launcher only after proving that it belongs to `hvir-workbench`.
It removes hvir's derived npm native cache only after the native installation succeeds. An
ambiguous command is retained and reported rather than overwritten or deleted silently.

Published `hvir-workbench` and platform payload packages remain immutable npm history. npm
publication stops and those packages are deprecated only after the complete native installation
and migration contract passes cumulative acceptance.

## Release contents and atomicity

One release manifest binds:

- the hvir version and source tag;
- the exact source commit;
- every supported artifact and architecture;
- every artifact's SHA-256 digest; and
- the matching third-party notices.

Linux x64, Linux arm64, and macOS arm64 artifacts are built and exercised on matching native
runners. The macOS package additionally passes application and installer signature validation,
Gatekeeper assessment, notarization, and stapled-ticket validation. Native installation
acceptance proves the installed command, one real `node-pty` load, one worker round-trip, and
platform-specific system integration.

Release assembly remains private until every required artifact passes its target acceptance.
Only then is the installer published with the matched manifest, notices, and native packages in
one GitHub Release. Published tags and assets are immutable; any artifact correction requires a
new version.

Run the [Phase 8 gauntlet](phase8-performance-gauntlet.md) on a controlled matching host before
release. Implementation and acceptance evidence belongs in the governing issues, commits, pull
requests, and releases rather than in ADRs.
