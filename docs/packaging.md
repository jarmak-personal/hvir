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
installation methods. [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) owns
the durable distribution, trust, privilege, update, removal, and migration boundaries.

Pull-request CI builds the Linux release artifacts on the Ubuntu 22.04 ABI baseline, then runs
native package acceptance for those same artifacts on Ubuntu 22.04, Ubuntu 24.04, and current
Debian stable userspaces on both x64 and arm64. It also runs native package acceptance on macOS
arm64.
It temporarily runs `npm run smoke:macos:ci` against the unpackaged build on Apple silicon,
covering the focused custom-profile PTY lifecycle, source/diff position, platform, and renderer
recovery contracts. Terminal presentation remains in the full local/pre-push `npm run
smoke:macos` command. macOS capacity is also temporarily local-only while its native PTY teardown
flake is hardened; Linux CI continues to run `npm run smoke:capacity` for deterministic
multi-terminal contracts and machine-dependent evidence. These commands are locally reproducible
only on a matching supported platform; CI supplies the remaining cross-platform contract evidence,
not an authoritative quantitative performance verdict.

Installed-package acceptance launches the public command with fresh disposable roots, waits for
the package-owned main process and a live renderer, and then proves the complete test-owned
process group stops. It also inspects the actual packaged application for production worker
entrypoints, the matching native `node-pty` payload, and absence of the Electron smoke graph and
activation path. This exact-artifact boundary does not claim that the installed application
loaded `node-pty` or completed a utility-process round trip; matching-target unpackaged Electron
smoke owns those behavioral contracts.

## Supported targets

| Platform | Architecture | Artifact | Compatibility contract |
| --- | --- | --- | --- |
| Linux | x64 | `.deb` | Debian package tools, glibc 2.35+, GCC 12 libstdc++6+, required libraries, production Chromium sandbox |
| Linux | arm64 | `.deb` | Debian package tools, glibc 2.35+, GCC 12 libstdc++6+, required libraries, production Chromium sandbox |
| modern macOS | Apple silicon (`arm64`) | flat `.pkg` | `/usr/sbin/installer` |

Linux support is capability-based, not an `ID`, `ID_LIKE`, or `VERSION_ID` allowlist. The
continuing matrix exercises Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, and current Debian stable on both
released architectures. Compatible Debian-package derivatives and future versions do not need an
identity exception. Non-Debian package managers, Intel macOS, Windows, direct package
installation, DMG, ZIP, AppImage, Homebrew, Snap, Flatpak, and other package formats are not
release targets.

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

1. Detects one supported operating system and architecture and checks its required capabilities
   without elevation.
2. Selects one exact artifact from the same release.
3. Downloads it over GitHub HTTPS.
4. Verifies its SHA-256 digest against the release-specific digest embedded in the installer.
5. Invokes only the exact native package operation that requires elevation.

The installer never executes an unverified native package. Before Linux elevation it requires
the Debian `dpkg` and `apt` tools, verifies glibc 2.35 or newer, checks the available Chromium
sandbox path, and simulates installation of the verified package so missing system libraries or
repository dependencies fail without changing the system. A clean installation requires Bash
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
Chromium's setuid sandbox helper. When the active kernel exposes the Ubuntu 24.04-style
`apparmor_restrict_unprivileged_userns` policy, the installer validates the packaged AppArmor 4
profile before elevation and the package lifecycle loads, updates, unloads, and removes it. Hosts
without that restriction receive no hvir AppArmor profile. Production launch never adds
`--no-sandbox` and does not require a user to edit AppArmor, change a sysctl, or repair ownership
or permissions.

### macOS

The Apple-silicon application is signed with a Developer ID Application identity. A Developer ID
Installer identity signs the flat `.pkg`; Apple notarizes the package, and the released artifact
carries a stapled ticket. The package owns:

- `/Applications/hvir.app`
- `/usr/local/bin/hvir`

After digest verification, the installer asks `/usr/sbin/installer` to install the package
noninteractively. The supported flow does not open Finder or Installer.app.

Pull-request CI builds and exercises the unsigned package structure without receiving signing
credentials. The protected signed-package workflow is both the reusable macOS release builder and
a manually dispatched pre-merge acceptance workflow restricted to the exact tip commit of the
selected branch. Both paths use the `native-release-signing` environment.
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
- `IMMUTABLE_RELEASES_READ_TOKEN`: a fine-grained GitHub token restricted to this repository with
  read-only Administration permission, used only to verify immutable releases are enabled before
  publication. The workflow's built-in token remains the release publication credential.

The protected workflow refuses tags, stale manual branch tips, and source commits not contained in
the release branch. It signs the hardened application and installer, notarizes and staples the
package, validates both identities and Gatekeeper acceptance, and retains the package only after
native install, update, launch, and removal acceptance passes.

The separately signed [macOS LAN SSH coexistence application](macos-ssh-acceptance.md) is
contributor acceptance tooling, not another installer or release artifact. It reuses the protected
Developer ID Application input but has a distinct bundle identity and state root; it does not
change the release package, notarization, `/Applications/hvir.app`, or `/usr/local/bin/hvir`
contract.

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

The `Release` workflow is the only publication path. `patch`, `minor`, and `major` dispatches keep
the version-only release pull-request flow. Preparation validates only the generated version
change; it does not install dependencies or rerun product verification and Electron smoke. An
untouched same-repository bot release pull request runs one read-only integrity job that proves
its identity, exact two-file change set, synchronized semantic versions, and absence of other
package or lockfile changes. Product verification, Electron, capacity, and CodeQL jobs are
condition-skipped for only that pull-request event. Any ordinary pull request or non-bot
release-branch update retains the complete CI and CodeQL gates.
GitHub marks workflows opened by the repository `GITHUB_TOKEN` as approval-required; approving
that bot pull request starts the focused integrity job, not the skipped matrices.

Merging the release pull request creates the exact default-branch source commit. Its `push` event
runs the remaining correctness CI once. A `current` dispatch observes GitHub Actions while that
commit's first-attempt CI is not yet registered or is still running. The bounded 45-minute
observation horizon covers the required CI graph's 15-minute configured critical path plus a
30-minute aggregate allowance for ordinary hosted-runner scheduling. The Release evidence step
and enclosing job have larger timeouts, so they cannot expire before that horizon. Release never
starts or reruns CI. Exact CI success continues the release automatically; a terminal failure or
exhausted observation horizon fails closed before native build or publication work.

Release builds the Linux x64 and arm64 packages once from that exact source on matching native
Ubuntu 22.04 runners. Each baseline job completes installed-package acceptance before retaining
the public-name artifact and a SHA-256 sidecar. Ubuntu 24.04 and Debian stable jobs download and
verify that same current-run artifact rather than rebuilding it. The protected release environment
builds, signs, notarizes, staples, and exercises the macOS package, then retains it with its own
digest sidecar. Assembly accepts only the exact three artifact-and-digest pairs from the current
Release run after every native acceptance job succeeds. A missing, renamed, unexpected,
wrong-version, inaccessible, or digest-invalid artifact stops the release before tag or draft
creation.

A trusted `current` dispatch produces exactly these assets:

- `hvir-<version>-linux-x64.deb`;
- `hvir-<version>-linux-arm64.deb`;
- `hvir-<version>-darwin-arm64.pkg`;
- `install.sh`;
- `SHA256SUMS`;
- `release-manifest.json`; and
- `THIRD_PARTY_NOTICES.md`.

The release manifest binds the hvir version and source tag, exact source commit, supported
platforms and architectures, artifact names and SHA-256 digests, installer digest, and notices
digest. `SHA256SUMS` covers every release asset except itself. The assembler refuses missing,
unexpected, or misnamed native inputs and proves that the installer embeds the same native
artifact names and digests.

Linux x64 and Linux arm64 artifacts are built and exercised on matching native Ubuntu 22.04
runners in the exact-source Release run, then those same digest-bound artifacts are exercised on
Ubuntu 24.04 and Debian stable userspaces on matching native architectures before assembly. The
macOS arm64 artifact is built and exercised on its matching native runner in the protected
Release workflow. It
additionally passes application and installer signature validation, Gatekeeper assessment,
notarization, and stapled-ticket validation. Native installation acceptance proves the installed
command, ordinary main/renderer startup, production payload structure, smoke-runner absence, and
platform-specific system integration. Matching-target Electron smoke separately proves the real
`node-pty` ABI/lifecycle and production worker/renderer IPC behavior before publication.

Before cutover, enable immutable releases in the repository Releases settings. The workflow checks
the repository setting through GitHub's API before creating a tag or draft and fails closed when
it is disabled. Release assembly remains private until every required artifact passes its target
acceptance. Only then does the workflow create or repair a draft, upload and compare the exact
seven-asset set, and publish it as latest. Publication makes the tag and assets immutable; any
artifact correction requires a new version. A failed draft may be repaired only while it remains
private.

After publication, the workflow downloads the assets again, validates `SHA256SUMS`, and requires
GitHub's generated release attestation to pass for the release and every downloaded asset:

```sh
gh release verify v<version>
gh release verify-asset v<version> ./hvir-<version>-linux-x64.deb
```

The historical `hvir-workbench`, `hvir-linux-x64`, `hvir-linux-arm64`, and
`hvir-darwin-arm64` versions are deprecated with the native-installer migration message after
the successful native cutover. Release automation retains no npm credentials or registry
mutation authority; it never publishes, deprecates, or unpublishes an npm version.

Run the [Phase 8 gauntlet](phase8-performance-gauntlet.md) on a controlled matching host before
release. Implementation and acceptance evidence belongs in the governing issues, commits, pull
requests, and releases rather than in ADRs.
