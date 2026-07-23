# Packaging and npm releases

hvir has one supported installation path:

```sh
npm install -g hvir-workbench
hvir
```

The public `hvir-workbench` package is a small launcher that installs the `hvir` command.
npm selects one hidden optional payload for the current machine:

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
platform package and creates the launcher package from the repository version. Platform packages
declare no install-time lifecycle scripts. Linux and macOS intentionally use the same archive
lifecycle even though macOS framework symlinks are the constraint that requires it.

On the first `hvir` launch for a version, the launcher verifies the installed archive, prepares it
atomically in the user's cache, and starts the native executable. Later launches reuse the
completed payload. The launcher never writes to the global npm prefix, so launch does not require
elevation even when that prefix is read-only. Users do not approve install scripts, compile hvir
or `node-pty`, or download a second payload. ADR-018 owns this lifecycle.

The preparation cache is `$XDG_CACHE_HOME/hvir/native` (or `~/.cache/hvir/native`) on Linux and
`~/Library/Caches/hvir/native` on macOS. Each platform package retains the current and immediately
previous completed versions. Failed staging is removed immediately when possible and otherwise by
the next preparation. A script-free uninstall cannot remove user cache state, so uninstall may
leave those two completed versions and at most one interrupted staging directory. When hvir is not
running, the corresponding `hvir/native` cache directory may be removed safely.

The permission to write npm's configured global prefix remains an npm/user-environment concern,
not a package capability. hvir never invokes or recommends `sudo`; [npm's own
guidance](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/)
recommends a Node version manager or a user-owned prefix when a system prefix produces `EACCES`.

The launcher package, platform package, and installed Electron application each carry
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Packaging verifies the notice at
both npm and application-resource boundaries so upstream attributions and hvir's local
modification disclosure cannot be dropped silently.

Local package commands are architecture-specific:

```sh
npm run pack:npm:launcher
npm run pack:npm:linux:x64    # native Linux x64 host
npm run pack:npm:linux:arm64  # native Linux arm64 host
npm run pack:npm:mac:arm64    # Apple-silicon Mac
```

Tarballs land in `dist/npm/`. Every platform pack command installs its generated tarball under
strict install-script policy, verifies that it declares no scripts, prepares it through the real
launcher-owned module, and validates the executable and notices before succeeding.
After also packing the launcher, `npm run smoke:packaged` installs both tarballs into a clean
prefix with no script approval, makes that prefix read-only, and launches twice. It proves the
first launch prepares visibly in the user cache, the second reuses the result, a project path is
preserved, the executable architecture matches the host, one real node-pty and one worker load,
the required preview protocol responds, and the retained platform geometry holds. macOS also
checks the framework symlink and the prepared bundle's documented signing state. It does not
replay ordinary product behavior already owned by unpackaged tests.

Pull-request CI runs that packaged contract on Linux x64, Linux arm64, and macOS arm64.
It also runs `npm run smoke:macos` against the unpackaged build on Apple silicon, covering
the focused custom-profile PTY lifecycle, source/diff position, and platform contracts.
Both commands are locally reproducible only on a matching supported platform; CI supplies
the cross-platform evidence.

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
5. Publishes `hvir-workbench` last, so its optional dependencies already exist at the
   same version.
6. Publishes a generated-notes GitHub Release only after npm publication succeeds. It
   has no downloadable application assets; npm remains the only supported distribution.

The workflow owns tag creation; manually pushing a tag is not a release trigger. The tag
always equals the root package version (`v0.1.0` for version `0.1.0`).

The initial `v0.1.0` attempt published the three platform payloads, but npm rejected the
unscoped `hvir` launcher as too similar to an existing package. The launcher is therefore
published as `hvir-workbench`; its `bin` entry still installs the command as `hvir`. Make
the first complete release with a `patch` bump to `0.1.1`, rather than rewriting the
partial tag or immutable payload versions.

Keep the granular npm publishing token in the `NPM_TOKEN` repository secret to bootstrap
`hvir-workbench`. Afterward, configure its npm trusted publisher for repository
`jarmak-personal/hvir`, workflow filename `release-npm.yml`, and the `npm publish` action.
The three platform packages should already have the same trusted-publisher configuration.
Then remove the long-lived token; the publish job already has the required OIDC permission
and emits provenance attestations.

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
bundle is archived into `hvir-darwin-arm64`. npm installs that archive byte-for-byte and
first-use preparation preserves the framework links and signing and notarization state.

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

## Historical implementation evidence

On 2026-07-15, `hvir-darwin-arm64@0.1.0` packed to a 160.9 MB npm tarball and validated the
original install-time extraction path. ADR-018 subsequently replaced that lifecycle with
script-free first-use preparation. Current acceptance comes from the native packaged-smoke jobs
on Linux x64, Linux arm64, and macOS arm64; release evidence belongs with the corresponding
commit, pull request, and release rather than this guide.
