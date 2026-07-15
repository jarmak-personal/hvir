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

## Release workflow

Pushing a `v*` tag runs `.github/workflows/release-npm.yml`:

1. Verify and smoke the source tree on Linux.
2. Build and smoke Linux x64, Linux arm64, and macOS arm64 on native runners.
3. Publish the three platform packages.
4. Publish `hvir` last, so its optional dependencies already exist at the same version.

The tag must equal the version in the root `package.json` (`v0.1.0` for version `0.1.0`).
The first publish bootstraps the four unscoped package names with a granular npm token in
the `NPM_TOKEN` repository secret. After that, configure each package's npm trusted
publisher for `release-npm.yml` and remove the long-lived token; the workflow already has
the required OIDC permission and emits provenance attestations. Workflow artifacts are
only short-lived handoff files between build and publish jobs; they are not supported
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
