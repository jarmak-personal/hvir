# Packaging and npm releases

hvir has one supported installation path:

```sh
npm install -g hvir
hvir
```

The public `hvir` package is a small launcher. npm selects one hidden optional payload
for the current machine:

| Platform | Payload package |
| --- | --- |
| Linux x64 | `hvir-linux-x64` |
| Linux arm64 | `hvir-linux-arm64` |
| macOS arm64 | `hvir-darwin-arm64` |

Intel macOS, Windows, native installers, and downloadable dmg/zip/AppImage/deb files are
not release targets. Keeping one user-facing install/update/remove workflow is an
intentional product-support boundary, not merely a CI convenience.

## How the packages are built

electron-vite builds the production `out/` tree. electron-builder then produces an
unpacked application on a native runner so Electron and `node-pty` have the correct
architecture. `scripts/package-npm.mjs` archives that directory into the matching
platform package and creates the launcher package from the repository version.

The platform package's install script expands its integrity-checked application payload
inside that npm package. The launcher locates the selected package and starts its native
application. Users do not compile hvir or `node-pty`; installs with npm
`--ignore-scripts` are unsupported because the payload cannot be expanded.

Local package commands are architecture-specific:

```sh
npm run pack:npm:launcher
npm run pack:npm:linux:x64    # native Linux x64 host
npm run pack:npm:linux:arm64  # native Linux arm64 host
npm run pack:npm:mac:arm64    # Apple-silicon Mac
```

Tarballs land in `dist/npm/`. Every platform pack command installs its generated tarball
into a temporary npm prefix and verifies the extracted executable before succeeding.
After also packing the launcher, `npm run smoke:packaged` installs both tarballs into a
clean prefix and exercises the complete `hvir` launcher → native application chain.

## Dependency and security automation

Dependabot checks npm dependencies daily and GitHub Actions weekly. Minor and patch
updates are grouped by ecosystem to keep routine maintenance compact; major updates stay
in individual pull requests so their compatibility and migration notes remain visible.
Repository settings also enable vulnerability alerts and Dependabot security-update pull
requests. Every update pull request goes through the full Linux CI gauntlet.

CodeQL analyzes JavaScript and TypeScript on pull requests, pushes to `main`, and a weekly
schedule. Before starting a release, review the open Dependabot pull requests and confirm
that CI and CodeQL are green on `main`; intentionally deferred major upgrades should be
called out in the release notes.

## Release workflow

Use **Actions → Release → Run workflow** on the `main` branch and choose a version:

- `current` releases the version already in `package.json`. It is also the recovery
  choice for an interrupted release whose tag already exists.
- `patch`, `minor`, or `major` updates `package.json` and `package-lock.json`, verifies
  that tree, and pushes the version commit to `main` before the native builds begin.

The one `.github/workflows/release-npm.yml` run then:

1. Verifies and smokes the exact release source on Linux.
2. Builds and smokes Linux x64, Linux arm64, and macOS arm64 from that exact commit on
   native runners.
3. Creates or verifies the matching `v*` tag after every native build succeeds.
4. Publishes the three platform packages, skipping versions already present during a
   recovery run.
5. Publishes `hvir` last, so its optional dependencies already exist at the same version.
6. Publishes a generated-notes GitHub Release only after npm publication succeeds. It
   has no downloadable application assets; npm remains the only supported distribution.

The workflow owns tag creation; manually pushing a tag is not a release trigger. The tag
always equals the root package version (`v0.1.0` for version `0.1.0`). For the first
release, add a granular npm publishing token as the `NPM_TOKEN` repository secret and run
the workflow with `current` to bootstrap the four unscoped package names. Afterward,
configure each package's npm trusted publisher for repository `jarmak-personal/hvir`,
workflow filename `release-npm.yml`, and the `npm publish` action. Then remove the
long-lived token; the publish job already has the required OIDC permission and emits
provenance attestations.

Version commits and release tags are pushed with the repository's GitHub Actions token.
If `main` branch protection or tag rules are added later, they must permit this workflow
to update `main` for version bumps and create `v*` tags; otherwise a release will stop at
the corresponding push after its earlier validation or builds.

If a run fails before creating the tag, fix `main` and rerun with `current`. If the tag
exists, `current` may safely finish an otherwise unchanged partial release and skips any
package versions already published. If npm contains the version but its tag is missing,
the workflow refuses to retag potentially different source; restore the original tag or
release a new version. Published npm versions are immutable: if an artifact itself must
change, make the fix and release a new patch instead. Workflow artifacts are only
short-lived handoff files between build and publish jobs; they are not supported
downloads.

## macOS signing decision

As of 2026-07-15, development payloads are unsigned because hvir has no configured Apple
Developer team/certificate. That is acceptable for development validation, not broad
public distribution. Before promoting the npm path publicly, remove `mac.identity: null`,
configure a Developer ID Application certificate, enable electron-builder notarization,
and retain the checked-in hardened-runtime entitlements. Signing happens before the app
bundle is archived into `hvir-darwin-arm64`, so npm does not alter the signed bundle.

Verify the expanded application before publishing:

```sh
codesign --verify --deep --strict --verbose=2 path/to/hvir.app
spctl --assess --verbose --type exec path/to/hvir.app
xcrun stapler validate path/to/hvir.app
```

See the [electron-builder signing guide](https://www.electron.build/docs/features/code-signing/code-signing-mac/),
[notarization guide](https://www.electron.build/docs/notarization/), and
[Apple distribution documentation](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

## Release acceptance

On each supported architecture, install the exact release tarballs through npm in a clean
environment, run `hvir`, register local and SSH projects, open Files and Git, start
shell/Codex/Claude terminals, quit, relaunch, and confirm recovery. Run the
[Phase 8 gauntlet](phase8-performance-gauntlet.md) before tagging and retain the real-host
evidence with the release notes.

## Current implementation evidence

On 2026-07-15, `hvir-darwin-arm64@0.1.0` packed to a 160.9 MB npm tarball. A clean
temporary npm prefix ran the platform package's postinstall extraction, verified the
arm64 executable, and passed the complete packaged-app smoke workflow through the
installed `hvir` launcher—including its project-path argument—from that exact payload.
The launcher tarball also passed `npm publish --dry-run` and its `hvir --version`/help
contract. Linux x64 and arm64 retain native CI build-and-smoke acceptance before they can
be published.
