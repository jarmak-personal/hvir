# Native terminal candidate packages

Native terminal candidates use the existing `.deb` and Apple-silicon `.pkg` package
owners. They do not publish a release or change the default terminal. The normal web
terminal remains the rollback choice until the separately accepted cutover.

The native dependency workflow builds the exact candidate's SDK and Node-API bindings
on matching native hosts. Candidate packaging validates both receipts against the
clean checked-out source before staging a payload:

```sh
node scripts/native-terminal/package.mts linux-x64 /trusted/exact-sdk/artifact out/native-terminal
HVIR_PACKAGE_NATIVE_TERMINAL=1 npm run pack:linux:x64
```

The equivalent targets are `linux-arm64` and `macos-arm64`. The SDK must be a trusted
exact-source workflow artifact; a self-reported manifest does not establish authorship.
Development libraries, supplied compiler/cache builds, a different SDK pin, and bindings
from a different source are refused. All three targets rebuild after an ordered patch
or pin change, including a patch whose behavior applies only to Linux.

The payload contains the full native library, dependency/font notices, its unchanged
SDK manifest and binding receipt, and a separate `runtime.json`. The native shaders
and required upstream embedded fonts reside in the built library; their identities
remain bound to the source archive, ordered patches, compiler/shader toolchain and
library digest. Controlled JetBrains/Fontconfig test fixtures are excluded. Production
font discovery retains system and user configuration; installing a candidate does not
replace `/etc/fonts` or impose a test font family.

Only the two approved Node-API addons and their JavaScript wrappers enter the application
package. Probe executables, headers, compiler inputs, caches, and fixture font
configuration are excluded. Linux explicitly declares `libegl1` alongside the existing
desktop dependencies, and `fontconfig-config` supplies the standard discovery rules.
EGL dispatch and a functioning graphics driver remain system
requirements. Package acceptance preserves the glibc 2.35 and GCC-12-era libstdc++ floors,
native package-manager ownership, and production Chromium sandbox rules.

An ordinary package without the native candidate opt-in refuses built native addons
as well as a staged native payload. Contributor bindings cannot silently enter a
package without its corresponding verified native manifest.

## Loading and formal-release signing

An installed candidate opts into native terminals with `HVIR_NATIVE_TERMINAL=1`.
Main resolves only its own `Resources/native-terminal` library and the two fixed
ASAR-unpacked addon paths. It checks manifest target, native versions, embedding ABI,
bounded regular files and final SHA-256 hashes before importing the native process
owner. File hashes stream in bounded asynchronous chunks. Manifest data cannot select
a path. The unpackaged development selector `HVIR_NATIVE_TERMINAL_LIBRARY` does not
select installed code.

Missing, corrupt, unsupported or mismatched components fail startup with a bounded
`native-package-*` stage before native process construction or terminal preparation.
That failure does not switch engines within a live session. Remove the candidate
opt-in and relaunch to select the existing web terminal, or reinstall the previous
verified package through the ordinary package manager. Settings, project registration
and provider-owned session recovery keep their existing formats and ownership.

Signing and notarization run only for formal releases, never for M14/M15/M16 or the
cumulative migration PR. Migration candidates use unsigned structural, installed and
relocation acceptance.

For a formal macOS release, the existing signing lifecycle signs the native dylib and both addons before
sealing the application. It records final hashes separately from immutable build
hashes and excludes those already signed files from subsequent ordinary re-signing.
The existing client signing owner then signs clients and seals the complete app.
Developer ID Application/Installer identities, hardened runtime, protected signing
credentials, exact source containment, notarization and stapling remain mandatory for
formal-release signed acceptance. An unsigned structural candidate is not Developer ID acceptance.
No entitlement or production sandbox bypass is required.

The native dependency and candidate package workflows have no signing route or signing
approval gate. Only the existing formal-release caller reaches the reusable protected
signed-package owner, with explicit merged-source intent and exact branch containment.
Native payload support remains in that owner; M16 owns wiring the accepted native default
and exact SDK artifacts into formal releases. Candidate construction neither requests
signing-environment authorization nor publishes a GitHub Release.

## Installed evidence

The installed package inspectors verify original receipts, final library/addon bytes,
notices, target and ABI after package construction, and after signing for formal releases. The existing disposable
installed-startup lifecycle uses the ordinary production app and local CDP to create,
exercise and close a native shell. It retains source/target/digest proof and verifies
native output, input, presentation, isolation and cleanup independently of the smoke
build graph. Relocation acceptance moves the original application implementation,
compiled output and native build-input paths before installed launch. Only shared
contracts and acceptance-tool support remain available in the original checkout;
the acceptance fixture and installer archives have separate owned paths.

Linux builds use Ubuntu 22.04 on each architecture. The same `.deb` is accepted on the
existing Ubuntu 22.04, Ubuntu 24.04 and Debian stable userspace matrix. Effective
Fontconfig/HarfBuzz versions are observed in the installed Electron utility, in
addition to ELF export/relocation inspection. Library inventory alone does not prove
which implementation an Electron-loaded dependency call executes.

Installed package and loader success is software acceptance. Hosted/Xvfb rendering,
pixel compatibility, unsigned relocation and clean teardown do not qualify physical
Linux GPUs, display backends or controlled performance. The separate hardware and
performance acceptance, including retained presentation-quarantine limitations,
remains required before default cutover.
