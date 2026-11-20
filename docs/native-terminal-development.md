# Test the native terminal from a branch

A normal development checkout prepares native Ghostty during `npm ci`; `npm run dev`
selects it automatically. No hvir token, GitHub login, transferred bundle, existing
Ghostty installation, or library-path configuration is needed. Public network access
is required to download dependencies during the first setup.

## Ubuntu 24.04

Use your regular user in a working desktop session, with Node 24+ and your installed
GPU driver. Supported Linux architectures are x86-64 and arm64. Install the build
prerequisites once:

```bash
sudo apt-get update
sudo apt-get install --yes git build-essential python3 pkg-config libegl-dev \
  libgl1-mesa-dri binutils file curl xz-utils patch
```

This preserves your existing NVIDIA/Intel/AMD driver; Mesa supplies the dependency
owner's offscreen checks, not a substitute for physical GPU qualification.

For a new checkout of the qualification branch:

```bash
git clone --branch agent/issue-1122 https://github.com/jarmak-personal/hvir.git
cd hvir
npm ci
npm run dev
```

For an existing checkout, close its dev app before changing branches/installing, then:

```bash
git fetch origin
git switch agent/issue-1122
git pull --ff-only
npm ci
npm run dev
```

The first install compiles the pinned full Ghostty renderer and native bindings.
Allow several minutes, public downloads, and several GiB of temporary disk space.
You may see compiler/download output while npm is installing. `npm ci --foreground-scripts`
shows that output live if you want it. Later installs reuse validated native artifacts
when their source inputs still match. Branch changes that alter native inputs trigger
rebuilding; unrelated application changes do not relabel or rebuild the native producer.

Run from your desktop, not SSH/Xvfb, for hardware testing. The dev launcher selects
`x11` or `wayland` from your desktop session and forwards it to Electron. To qualify a
specific available backend explicitly:

```bash
HVIR_NATIVE_TERMINAL_OZONE=x11 npm run dev
HVIR_NATIVE_TERMINAL_OZONE=wayland npm run dev
```

Normal launch uses your existing development profile. For a fresh isolated profile:

```bash
npm run dev -- -- --user-data-dir="$HOME/.hvir-native-test"
```

Both `--` delimiters are intentional. A fresh profile has no saved harness profiles;
use **Add a harness…** for locally available providers, or just test ordinary shells.
No harness login is required for shell testing.

## macOS

Apple silicon is supported. Install Node 24+, the native C build tools, and full Xcode
with its Metal toolchain. Select full Xcode using your usual developer setup, or use
a command-local selection:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm ci
npm run dev
```

If Metal is missing, install Xcode's Metal component. Development setup does not sign
or notarize the app; those operations remain restricted to formal releases.

## What setup prepares

The native build and binding owners download their pinned, hash-checked public inputs.
They compile locally and retain their original source, patch, ABI, toolchain and
development provenance. Outputs and the readiness receipt live under the ignored
`packages/native-terminal/build/` directory. Successful setup removes its temporary
compiler/source trees; failed attempts remain available for diagnosis. Nothing is
extracted manually into the checkout or `node_modules`.

The preflight checks native input bytes, the installed Electron version, SDK integrity,
binding provenance and binary hashes before launch. Missing, stale, or incompatible
assets stop launch with a repair instruction; they do not silently select ghostty-web.
To repair setup without reinstalling all npm dependencies:

```bash
npm run native:prepare
```

An interrupted setup may leave `packages/native-terminal/build/development/prepare.lock`.
Only remove that directory after confirming no earlier setup/compiler is still running,
then rerun preparation. Concurrent installs in the same checkout are not supported.

`npm run dev:legacy` explicitly launches the web engine for diagnosis. Existing smoke,
paired-comparison and packaged/release selection remain separately owned. Automatic
native selection here changes the development launcher only, not release cutover.
CI dependency installs (`CI=true`) skip automatic native compilation and print that
choice; dedicated native jobs still build and qualify their own artifacts. An explicit
`npm run native:prepare` builds even in CI. No runtime/acceptance gate is disabled.

## Manual testing and credential-free automated qualification

In the app, try typing, paste, selection/copy, rapid and slow scrollback, width toggle,
window resizing, splits, terminal switching, search (including a fullscreen TUI if
available), and closing/reopening terminals. Look for lost focus, light focus borders,
incorrect redraws, blank/frozen surfaces, and stale search highlights.

Paste this into an hvir shell for repeatable scroll output:

```bash
for ((i=1; i<=3000; i++)); do
  printf '%04d  Scroll test | alpha beta gamma | 0123456789 | findings\n' "$i"
done
```

For automation, quit the dev app first: the checks rebuild its output directory.
Look up the actual monitor refresh rate in Ubuntu **Settings → Displays**, then run
(with your rate in place of `144`):

```bash
set -o pipefail
npm run native:qualify -- --refresh-hz 144 2>&1 | tee "$HOME/hvir-native-qualification.log"
```

This reuses the prepared native library and runs the existing seam/ADR, lint, typecheck,
unit-test, smoke, native-workbench smoke, controlled capacity, and eight-process paired
comparison owners. It needs no account credentials. The runner prints a unique results
directory outside the checkout; preserve it and the log, including failed results.
Keep the desktop otherwise idle and use a consistent monitor configuration for timings.

Authenticated repository-governance checks remain separately required on the contributor
machine/CI; this credential-free command is runtime qualification, not the full gauntlet.
Report the tested Git commit, GPU/driver, desktop session, monitor refresh/scaling and
manual findings with the logs. Review logs for work-sensitive information before sharing.
A passing NVIDIA run does not qualify Intel/AMD, and software/headless success does not
qualify physical desktop presentation. macOS manual acceptance already recorded in #1122
remains accepted within its original scope.
