# Native terminal dependency builds

The native dependency owner builds the **full pinned Ghostty source**, including its renderer.
The stable libghostty-vt archive alone cannot produce this artifact. The application source is
`108cacb17ed8990840cd14abfce43d8ed8503ca1` (`1.4.1-dev`); its VT release is `1.0.1`.
The private embedding-hook ABI is `1`. These are independent identities.

This tooling produces libraries, maintained C bridge inputs, a separate-process loader probe,
and provenance. It creates no terminal, PTY, provider, renderer attachment or application host.
[ADR-086](adr/ADR-086-native-terminal-state-and-presentation.md) owns those later boundaries.

## Build and inspect

Use Node 24+, a native C compiler, tar, patch, and a matching native host. Supported targets are
`macos-arm64`, `linux-x64`, and `linux-arm64`. Linux release builds use the existing Ubuntu 22.04
native runner baseline; package and hardware acceptance remain separate.
Linux builds require `pkg-config` and EGL development files (`sudo apt-get install pkg-config
libegl-dev` on Ubuntu 22.04). The native library uses the system EGL dispatch runtime
(`libEGL.so.1`, Ubuntu package `libegl1`); a usable GPU driver remains separate acceptance.
The builder checks this prerequisite before downloading inputs, preserves pkg-config's system
library search flags for the explicit target, and records the pkg-config/EGL identities and
link flags. No GTK application or replacement EGL manager is built.

On macOS use full Xcode with its Metal component. A task-specific `DEVELOPER_DIR` selects Xcode
without changing the machine's global developer directory. If the component is absent, Apple's
`xcodebuild -downloadComponent MetalToolchain` prepares it. No shader source-compilation patch
or runtime source download is needed.

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  npm run native:build -- macos-arm64 /tmp/hvir-native-build-1
npm run native:check -- macos-arm64 /tmp/hvir-native-build-1/artifact
```

Use a **new** work directory for every attempt. The build obtains the pinned compiler and full
source from their immutable inputs, verifies archive digests, applies each recorded patch with
zero fuzz, fetches hash-checked upstream dependencies, and builds offline. Compilation is bounded
to two jobs. Interrupted/failed attempts remain available for diagnosis and are never overwritten.
The output is `WORK/artifact`; sources and caches remain outside the maintained repository tree.

For prepared inputs, the build also accepts `--zig PATH`, `--source-archive PATH`, and
`--packages PATH`. The compiler must report the exact selected version, the source archive must
match its pin, and `--packages` names the **unpacked** full dependency cache's `p` directory.
Builds record the compiler binary digest and all three prepared-input flags. Explicit compiler
paths and supplied package caches are contributor inputs and always mark the artifact
`development`; use the verified official compiler/dependency preparation for release builds.
A supplied source archive remains digest-verified against the accepted source pin.

The upstream `nix/build-support/fetch-zig-cache.sh` and `deps/packages.txt` cover the full source.
Do not substitute `deps/libghostty-vt.txt`. Run that script with pinned Zig on PATH and a dedicated
`ZIG_GLOBAL_CACHE_DIR`, then pass its `p` directory to `--packages`. The build uses a separate new
cache: upstream warns that an incomplete `--system` directory combined with old global cache
entries can crash Zig 0.17. Reuse canonical cached package archives directly; reimporting an
already normalized archive through `zig fetch` can introduce a second root directory.
The builder explicitly disables system integration for FreeType, HarfBuzz, Fontconfig, libpng,
zlib, Oniguruma and Fontconfig's libxml2 dependency: `--system` enables Linux's system-library defaults as well as offline
dependency lookup. These libraries come from the pinned dependency cache, as on macOS;
ambient distribution development packages are not build inputs.

Each manifest binds the hvir source commit, complete pin digest, target, upstream source digest,
ordered patches, compiler/SDK identities, build options and output hashes. Dirty maintained build
inputs are marked `development`; inspection rejects them unless `--development` is explicit.
A development artifact is not release evidence. Never edit a manifest to change that distinction.

The loader probe first opens the actual library, verifies the embedding-hook ABI, and reads
Ghostty's application version and optimization identity. Artifact inspection checks the
selected source identity and recorded-byte consistency before executing that probe. Use it only
for a trusted local build or an artifact from the exact trusted CI producer. Matching a supplied
manifest's own hashes does not authenticate authorship; never run this on arbitrary downloaded
bundles. Application source is statically forbidden from importing these contributor tools.
Runtime integration must establish its trusted packaged artifact boundary before loading native
code; M14 owns package signing and final-byte trust. Missing, corrupt, wrong-target,
wrong-ABI and wrong-version inputs fail before any terminal can be prepared. Later native-host
integration must consume this prerequisite before reserving/spawning a PTY; these scripts do not
enable or replace the application terminal path.

## Patch and upgrade ownership

`scripts/native-terminal/pin.json` is the complete input pin. Its one current upstream patch:

- installs the existing macOS shared-library output;
- skips the unused Linux static-library install and its separate full-core compile;
- links the Metal framework explicitly for that output;
- links system EGL into the Linux shared library; and
- exports the version of the upstream hooks consumed by the maintained C facade.

The patch changes upstream build/core exports only. hvir's own facade, loader, Node-API and OS
resource code belongs under `packages/native-terminal/` as maintained C/headers. No independent
hvir Zig implementation may be hidden in a reproduction patch.

Inspect a chosen immutable upgrade without changing accepted pins:

```sh
npm run native:upgrade -- FULL_40_CHARACTER_COMMIT /tmp/hvir-native-upgrade-1
```

Review the resulting source/archive identity, application and VT versions independently, minimum
Zig version, both dependency inventories, renderer changes and every ordered patch result. The
command preserves the clean candidate and trial-applies zero-fuzz forward patches on an owned
scratch copy. It reports VT identity from an accepted matching source pin or `LIB_VERSION`,
and otherwise requires explicit VT release selection; application version is never a substitute. Update the explicit pin and
patch digests in a focused reviewed change, rebuild all three targets, and re-run loader checks.
The command never selects an ambient latest release or publishes anything.

## Evidence boundaries and distribution

The `Native terminal dependency` workflow builds and executes the loader on matching native
Linux x64, Linux arm64 and macOS arm64 hosts. It preserves exact-source artifacts and notices in a tar archive, retaining the loader probe's
executable mode through GitHub artifact storage. The workflow extracts and checks that archive
on the matching host. After downloading from the trusted exact-source run, extract the tar
archive and run `native:check` from the corresponding source checkout.
This proves build/loader behavior, not EGL/Metal rendering, shared-resource transfer, installed
packages, signing/notarization or a supported GPU/driver combination. Linux GPU acceptance still
requires the real desktop path. No end user runs this compiler or downloads source at launch.

Artifact notices include Ghostty, embedded-font/vendor notices, Zig/LLVM runtime notices, and
the full dependency-cache license/copyright files; build
provenance remains immutable when later packaging signs outputs. Packaging must record signed
final-byte integrity separately, following the existing agent-client convention. M14 owns final
package contents, supported ABI/sandbox inspection, signing, relocation and installed acceptance.


The private ABI also builds the [native facade](native-terminal-facade.md). Matching-target
builds run real pthread state/geometry/reply/metadata and completed-frame lease probes,
including producer progress and retirement. Linux builds install Mesa's software renderer
for this owner-level test; software output is explicitly not hardware GPU qualification.
`facade-proof.json` records the actual resource kind, and `frame-metadata-proof.json`
records invalid/partial descriptor cleanup. Only the info-only loader may unload its library;
the initialized facade keeps Ghostty mapped until its native process exits.
