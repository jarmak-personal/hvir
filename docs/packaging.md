# Packaging and release artifacts

hvir uses electron-vite for its production bundle and electron-builder for native
artifacts. This follows electron-vite's current recommendation to build the complete
`out/` tree before packaging it.

## Local builds

Install dependencies once with `npm ci`, then build on the target operating system:

```sh
npm run dist:linux # AppImage and deb, on Linux
npm run dist:mac   # dmg and zip, on macOS
```

Artifacts land in `dist/` and include their operating system and architecture in the
filename. `npm run build:dir` remains the fast unpacked-app check. `npm ci` rebuilds the
required `node-pty` dependency for Electron's ABI. Packaging deliberately skips a second
blanket native rebuild so ssh2's optional `cpu-features` acceleration cannot break an
otherwise supported build; ssh2 uses its JavaScript fallback when it is unavailable.

The tag workflow builds Linux x64, macOS arm64, and macOS x64 artifacts on native GitHub
runners. It deliberately uploads workflow artifacts instead of publishing a GitHub
Release automatically; a human can attach the verified files to the release after the
real-host acceptance pass.

## macOS signing decision

As of 2026-07-15, v1 development and tag artifacts are unsigned. hvir does not yet have
an Apple Developer team/certificate configured, and the Phase 8 plan explicitly permits
unsigned v1 development builds. On another Mac, an unsigned build requires explicit
approval in System Settings → Privacy & Security before first launch.

This is appropriate for development distribution, not a broad public release. Before
public distribution, remove `mac.identity: null`, configure a Developer ID Application
certificate via `CSC_LINK` and `CSC_KEY_PASSWORD`, enable `mac.notarize: true`, and
provide either App Store Connect API-key credentials or Apple ID notarization credentials
to the macOS jobs. Keep the hardened runtime and checked-in Electron entitlements
enabled. Then verify every artifact with:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/hvir.app
spctl --assess --verbose --type exec /Applications/hvir.app
xcrun stapler validate /Applications/hvir.app
```

Code signing and notarization are separate requirements for direct macOS distribution;
electron-builder performs signing, notarization, and stapling when configured. See the
[electron-builder signing guide](https://www.electron.build/docs/features/code-signing/code-signing-mac/),
[notarization guide](https://www.electron.build/docs/notarization/), and
[Apple's distribution documentation](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

## Latest artifact evidence

On 2026-07-15, the Linux x64 `.deb` was extracted in a clean container and its packaged
app passed hvir's full smoke workflow; the executable and `node-pty` addon were verified
as x86-64. The macOS arm64 app was launched directly from the mounted DMG and passed the
same workflow; both binaries were verified arm64. AppImage and zip artifacts were also
produced. A clean-machine install with a real SSH project remains part of manual release
acceptance.

## Artifact acceptance

For a release candidate, install from the dmg/deb or launch the AppImage on a machine
without the source checkout. Register a local project and an SSH project, open Files and
Git, start shell/Codex/Claude terminals, quit, relaunch, and confirm recovery. Run the
[Phase 8 gauntlet](phase8-performance-gauntlet.md) before creating the tag and retain its
real-host evidence with the release notes.
