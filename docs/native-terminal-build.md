# Native terminal dependency builds

The native dependency owner builds the **full pinned Ghostty source**, including its renderer.
The stable libghostty-vt archive alone cannot produce this artifact. The application source is
`108cacb17ed8990840cd14abfce43d8ed8503ca1` (`1.4.1-dev`); its VT release is `1.0.1`.
The private embedding-hook ABI is `11`. These are independent identities.

This tooling produces libraries, maintained C bridge inputs, a separate-process loader probe,
and provenance. It creates no terminal, PTY, provider, renderer attachment or application host.
[ADR-086](adr/ADR-086-native-terminal-state-and-presentation.md) owns those later boundaries.

## Build and inspect

Use Node 24+, a native C compiler, tar, patch, and a matching native host. Supported targets are
`macos-arm64`, `linux-x64`, and `linux-arm64`. Linux release builds use the existing Ubuntu 22.04
native runner baseline; package and hardware acceptance remain separate.
Linux builds require `pkg-config`, EGL development files and Mesa software drivers for the
software-owner probe (`sudo apt-get install pkg-config libegl-dev libgl1-mesa-dri` on
Ubuntu 22.04). The native library uses the system EGL dispatch runtime
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
to two jobs by default. Interrupted/failed attempts remain available for diagnosis and are never overwritten.
The output is `WORK/artifact`; sources and caches remain outside the maintained repository tree.

For prepared inputs, the build also accepts `--zig PATH`, `--source-archive PATH`, and
`--packages PATH`. The compiler must report the exact selected version, the source archive must
match its pin, and `--packages` names the **unpacked** full dependency cache's `p` directory.
Builds record the compiler binary digest and all three prepared-input flags. Explicit compiler
paths and supplied package caches are contributor inputs and always mark the artifact
`development`; use the verified official compiler/dependency preparation for release builds.
A supplied source archive remains digest-verified against the accepted source pin.
For a resource-bounded development build, `--jobs 1` and `--local-cache EXISTING`
reuse a validated existing compiler cache; both require explicit prepared `--zig`
and `--packages` inputs. The artifact records the actual arguments and cache reuse.
Default builds retain two jobs and a fresh local cache. `--retirement-probe 1`
opts a Darwin build into the real C/resource writer-retirement proof; it does not
add a mandatory GPU requirement to ordinary headless builds. These build and
qualification commands do not invoke signing or notarization.

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

The Linux full shared library also uses an anonymous ELF export map. Only `ghostty_*`
and `hvir_ghostty_embed_abi` remain externally defined; bundled Fontconfig, HarfBuzz,
FreeType, libpng, zlib, Oniguruma and libxml2 definitions bind within that library.
LLVM/LLD is selected explicitly because Zig's self-hosted ELF linker may ignore the map.
This is export localization of the private full renderer API, not a stable libghostty-vt
symbol-version promise. Loader flags and sandbox policy stay unchanged.

Build and matching-host checks inspect actual dynamic symbols and relocations, reject
unexpected defined exports and preemptible bundled-dependency references, and record the
map digest plus observed export/import inventory. The dependency list alone does not
establish effective binding. Installed acceptance must also observe the utility's actual
Fontconfig and HarfBuzz initialization calls under Electron (`21803` and `11.0.0` for
these pinned inputs), normal font discovery and shaping. Host Fontconfig configuration
and user fonts remain separate from library identity; controlled fixture configuration
is never a production font default. Linux still requires the package-declared EGL dispatch
runtime and a usable desktop driver; software package proof does not qualify real GPUs.

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
code; M14 owns unsigned package structure and final-byte trust. Missing, corrupt, wrong-target,
wrong-ABI and wrong-version inputs fail before any terminal can be prepared. Later native-host
integration must consume this prerequisite before reserving/spawning a PTY; these scripts do not
enable or replace the application terminal path.

## Patch and upgrade ownership

`scripts/native-terminal/pin.json` is the complete input pin and records every ordered patch
with its purpose and checksum. The initial build patch:

- installs the existing macOS shared-library output;
- skips the unused Linux static-library install and its separate full-core compile;
- links the Metal framework explicitly for that output;
- links system EGL into the Linux shared library; and
- exports the version of the upstream hooks consumed by the maintained C facade.

Later patches expose external transport, geometry, presentation, input, effects, selection,
retained queries, and typed appearance on the same native Surface. The appearance hook accepts
explicit font families, shaping, colors and cursor defaults, skips font-grid rebuilds for
palette-only changes, and preserves external-media restrictions during reload.

The patches change upstream build/core exports only. hvir's own facade, loader, Node-API and OS
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
provenance remains immutable when formal-release packaging signs outputs. Formal releases record
signed final-byte integrity separately, following the existing agent-client convention. M14 owns
unsigned package contents, supported ABI/sandbox inspection, relocation and installed acceptance.
Signing/notarization runs only for formal releases, never as a migration gate.
The [candidate packaging contract](native-terminal-packaging.md) describes exact-source
assembly, final-byte manifests, installed selection, rollback and formal-release signing.


The private ABI also builds the [native facade](native-terminal-facade.md). Matching-target
builds run real pthread state/geometry/reply/metadata and completed-frame lease probes,
including producer progress and retirement. Linux builds install Mesa's software renderer
for this owner-level test; software output is explicitly not hardware GPU qualification.
`facade-proof.json` records the actual resource kind, and `frame-metadata-proof.json`
records invalid/partial descriptor cleanup. Only the info-only loader may unload its library;
the initialized facade keeps Ghostty mapped until its native process exits.

The normal facade probe runs directly with C debug symbols/frame pointers and
content-free phase markers. After a failed Linux invocation, CI additionally records a
batch-gdb reproduction with all-thread backtraces. That diagnostic does not change the
original failed acceptance result. CI retains the diagnostic logs; local native builds do
not require gdb.

The consuming Node-API bindings and actual utility/OS-right/Electron qualification
are described in [native terminal host](native-terminal-host.md). Their receipt
records both the trusted producer revision and the consuming binding revision;
reusing an accepted native library does not imply it was built from the consumer.
