# Install hvir manually

Download a native package, verify it, then install it with macOS Installer or Linux `apt`.
You do not need to execute `install.sh`, install Node.js/npm, or use a GitHub-specific verifier.
This guide covers **clean native installations and updates to native installations**.

If you previously installed `hvir-workbench` through npm, use the existing
[release-installer migration workflow](packaging.md#install-update-uninstall-and-purge).
It proves launcher ownership and completes native installation before removing the legacy
launcher and derived cache. These manual steps do not migrate or clean up npm installations.

## Choose and download one release

Open [hvir Releases](https://github.com/jarmak-personal/hvir/releases), select one published
release, and expand **Assets**. Download its `SHA256SUMS` and exactly one package into a new
folder you own. Keep all files from that same release; do not mix a package from a pinned release
with a checksum downloaded through `latest`. Use the published assets, not GitHub's source archives.

Run `uname -m` in Terminal to check the machine architecture. On Linux also run
`dpkg --print-architecture`; the Debian architecture must agree with the selected package.
On Apple silicon use a native Terminal, not a shell running under Rosetta.

| Host | Architecture output | Package asset (`<version>` is the release version without `v`) |
| --- | --- | --- |
| Modern macOS, Apple silicon | `arm64` | `hvir-<version>-darwin-arm64.pkg` |
| Linux with Debian package tools | `x86_64`, Debian `amd64` | `hvir-<version>-linux-x64.deb` |
| Linux with Debian package tools | `aarch64` or `arm64`, Debian `arm64` | `hvir-<version>-linux-arm64.deb` |

Intel macOS, Windows, other architectures, and other package formats are unsupported. Linux needs
Bash, `sudo`, `dpkg`, `apt`, glibc 2.35+, GCC 12 libstdc++6+, resolvable desktop dependencies,
and a working production Chromium sandbox. A distribution name alone does not establish support.
The [packaging guide](packaging.md#supported-targets) describes the continuing Linux matrix.

hvir uses system `git`. Install the Claude Code or Codex CLI separately if you want its launch
options; plain shell sessions work without either CLI.

## Check existing commands and destinations

Before installing, quit hvir and let any running harness work finish. In your normal terminal:

```sh
type -a hvir
```

For a clean installation, no `hvir` alias, function, or executable should resolve. Also inspect
the native destinations below, even if they are outside your `PATH`. Missing files are expected
on a clean host. Existing files or symlinks must belong to the native installation being updated.

- **macOS:** `/Applications/hvir.app`, `/usr/local/bin/hvir`, and
  `/Library/Application Support/hvir/package-inventory-v1.txt`. For an update, use the receipt
  and inventory checks in [macOS removal](#macos-removal) to confirm the existing ownership.
- **Linux:** `/opt/hvir`, `/usr/bin/hvir`, `/etc/alternatives/hvir`,
  `/usr/share/applications/hvir.desktop`, and `/etc/apparmor.d/hvir`. For an update,
  `dpkg-query -W -f='${Status} ${Version}\n' hvir` must report `install ok installed`.
  Inspect `dpkg-query -L hvir` and `update-alternatives --query hvir`: the selected command must
  be `/opt/hvir/resources/hvir-command`. The command alternative and active AppArmor profile
  are created by package scripts, so they are not necessarily listed as payload files by `dpkg`.

Stop for an npm launcher, an unowned destination, a different command alternative, or uncertain
ownership. Resolve it with the owning installation mechanism or maintainer before continuing.
Do not delete, overwrite, force an alternative, or repair permissions on an unowned command to
make this guide work. Native package tools do not check every command in your shell's `PATH`;
Linux package scripts can replace the command link at the native destination.

## Verify before elevation

In Terminal, change into the download folder. Set `package` to the **exact filename you downloaded**.
For example, for release v0.2.2 on macOS:

```sh
package='hvir-0.2.2-darwin-arm64.pkg'
```

On Linux, use the corresponding `.deb` filename instead, for example
`package='hvir-0.2.2-linux-x64.deb'`. Repeat this selection for each newer release.

Print the matching checksum entry:

```sh
awk -v name="$package" '$2 == name { print }' SHA256SUMS
```

Require exactly one entry with the exact filename. Compute the downloaded file's digest:

```sh
# macOS
shasum -a 256 "$package"
```

```sh
# Linux
sha256sum "$package"
```

Compare all 64 hexadecimal characters with the matching `SHA256SUMS` entry. Continue only if
they match exactly. A missing entry, duplicate entry, unexpected filename, or different digest
means stop and download again from the selected release. Do not elevate to perform these checks.

GitHub HTTPS and the immutable release are the trust root. This comparison detects a wrong or
corrupted download; it is not an independent signature over `SHA256SUMS`. Neither macOS Installer
nor `apt` compares a local package with that release's checksum file. The
[release attestation](packaging.md#installer-and-trust-contract) remains an optional audit path.

## macOS: check and install

Before opening the package, run these unprivileged checks in the same download folder:

```sh
pkgutil --check-signature "$package"
xcrun stapler validate "$package"
spctl --assess --type install --verbose=2 "$package"
```

Every command must succeed. Require a trusted timestamp, a Developer ID Installer certificate
for **Benjamin Jarmak (U6UWMZHK48)**, a valid stapled ticket, and Gatekeeper `accepted` with a
notarized Developer ID source, without a security-disabled override. That is the publisher
identity used by the released installer.
If it differs, stop and establish the expected identity from the selected release's `install.sh`
(`HVIR_MACOS_TEAM_ID`, viewed as text without executing it) and maintainer release information.
Do not accept an arbitrary signed package. If `stapler` is unavailable, install Apple's Command
Line Tools using `xcode-select --install`, then repeat the checks before opening the package.
Do not bypass Gatekeeper, remove quarantine attributes, or disable signature checks.

Double-click the verified `.pkg` in Finder to open **Installer**, choose the startup disk, and
follow its prompts. Supply administrator authorization only at the installation step. Installer
also applies Apple's package trust checks; the package scripts validate the installed app and
create the package-owned command and inventory. Apple's
[Gatekeeper guidance](https://support.apple.com/en-us/102445) describes its signature and
notarization checks.

This is a system package installation. It owns `/Applications/hvir.app`, `/usr/local/bin/hvir`,
the system inventory, and receipt `dev.hvir.app`. Extracting or copying only `hvir.app` into
Applications omits command and receipt integration and is not a supported installation path.

After Installer reports success, check the receipt version and installed application:

```sh
pkgutil --pkg-info dev.hvir.app
codesign --verify --deep --strict --verbose=2 /Applications/hvir.app
spctl --assess --type exec --verbose=2 /Applications/hvir.app
```

The receipt must show the selected version, and both application checks must succeed. If any
step fails, retain the Installer error and inspect its log; do not treat a present app bundle
alone as a successful installation.

## Linux: check and install

Run these checks as your ordinary desktop user after verifying the `.deb`:

```sh
getconf GNU_LIBC_VERSION
dpkg-deb --field "$package" Package Version Architecture Depends
apt-get --simulate --no-install-recommends install "$(pwd)/$package"
```

Require glibc 2.35 or newer, package name `hvir`, the selected version and architecture, and a
successful dependency simulation. The declared dependencies include `libc6 (>= 2.35)`,
`libstdc++6 (>= 12)`, and desktop libraries; configured repositories must be able to supply them.
The simulation must not propose unexpected removals or downgrades. A non-root simulation can be
incomplete if APT configuration is unreadable; resolve that condition before continuing.
See Debian's [APT simulation documentation](https://manpages.debian.org/bookworm/apt/apt-get.8).

Check the available sandbox route without elevation:

```sh
unshare --user true
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
```

A successful `unshare` probe demonstrates unprivileged user namespaces. A missing AppArmor
sysctl is normal on hosts without that restriction. If the sysctl is `1`, **regardless of the
probe result**, require active AppArmor tools and check the profile from the verified package:

```sh
/usr/sbin/apparmor_status --enabled
package_check_dir=$(mktemp -d)
dpkg-deb --extract "$package" "$package_check_dir"
/usr/sbin/apparmor_parser --skip-kernel-load --debug \
  "$package_check_dir/opt/hvir/resources/apparmor-profile"
```

All three operations must succeed. This parses the profile without loading it into the kernel.
After inspection, remove only the temporary extraction folder you just created. If the sysctl
cannot be read for a reason other than absence, the tools are unavailable, enforcement cannot be
confirmed, or the profile cannot be parsed, stop before installation.

When unprivileged namespaces fail and the AppArmor restriction is absent or `0`, the package
supplies a root-owned setuid `chrome-sandbox` helper. The installation filesystem must allow
setuid execution and host policy must permit that sandbox. A container's blocked namespace
probe is not proof that the helper can work. On a managed host, confirm the route with its
administrator. Do not change global sysctls/AppArmor policy, manually chmod the helper, or launch
with `--no-sandbox`.

Once preparation passes, install the verified local file:

```sh
sudo apt install --no-install-recommends "$(pwd)/$package"
```

Review APT's final transaction before agreeing. APT resolves dependencies and invokes the Debian
package scripts; it does not authenticate this downloaded local `.deb` against GitHub. The
scripts own `/opt/hvir`, command integration, desktop metadata, sandbox-helper permissions, and
loading the AppArmor profile when required. They remove stale package-owned AppArmor state when
it is no longer required.

Check `dpkg-query -W -f='${Status} ${Version}\n' hvir` for `install ok installed` and the selected
version. A failed dependency or package-script operation is an installation failure even if files
exist. Retain APT's error and resolve the native package-manager state before retrying; do not
launch a partial installation or bypass its sandbox requirements.

## Launch and update

Open **hvir** from your Linux application menu or macOS Applications/Spotlight. In a new terminal,
check `type -a hvir` and `command -v hvir`. They should select `/usr/bin/hvir` on Linux or
`/usr/local/bin/hvir` on macOS, without an alias, function, or earlier conflicting launcher.
If the directory is absent from `PATH`, add that native command directory to your shell's path
and reopen the terminal; do not create another launcher.

From a local project directory, run:

```sh
hvir .
```

Confirm a usable hvir window opens that directory. Run as your ordinary user, never with `sudo`.
A relative project path resolves from the caller's directory; running `hvir` without a path
uses remembered workspaces. Diagnose launch errors in the invoking terminal. Linux sandbox
capability is established only when the installed application launches with its sandbox enabled.

To update, quit hvir, select a **newer** published release, and repeat package selection, checksum,
platform preflight, and installation. Install over the existing native package using Installer
or `apt`; do not remove it first. Confirm the new receipt/package version and repeat both launch
paths. Settings, registered-project metadata, and project directories remain in place. Downgrades
and migration from a copied app or npm installation are outside this manual path.

## Remove hvir

Quit hvir and finish running harness work first. Default removal preserves settings,
registered-project metadata, caches, local and remote project directories, and user-authored data.
It does not undo system dependencies installed by APT. There is no manual purge workflow here.

### Linux removal

```sh
sudo apt remove hvir
```

Review the removal transaction. The package manager and removal scripts remove the application,
desktop entry, package command alternative, and package-owned AppArmor profile, including its
loaded state when applicable. Check that `dpkg-query -W -f='${Status}\n' hvir` no longer reports
`install ok installed`; residual package-manager configuration state is not an installed app.
If a different `hvir` still resolves, inspect its owner rather than deleting it.

### macOS removal

macOS does not provide an equivalent package uninstall operation. First inspect the receipt,
its payload listing, the package-created inventory, and the installed command marker:

```sh
pkgutil --pkg-info dev.hvir.app
pkgutil --files dev.hvir.app
cat '/Library/Application Support/hvir/package-inventory-v1.txt'
grep -F 'hvir-native-package-command-v1' /usr/local/bin/hvir
```

Require a receipt for `dev.hvir.app` at `/Applications` whose files include
`hvir.app/Contents/MacOS/hvir`, the command marker, and this inventory:

```text
hvir-native-package-inventory-v1
package-id=dev.hvir.app
application=/Applications/hvir.app
command=/usr/local/bin/hvir
inventory=/Library/Application Support/hvir/package-inventory-v1.txt
receipt=dev.hvir.app
```

The app, command, and inventory must still be the package-owned installation, not replaced
files or redirected symlinks. Stop if anything is missing, inconsistent, or unowned; do not guess
which files to delete. Once confirmed, remove only those recorded system files:

```sh
sudo /bin/rm -rf -- /Applications/hvir.app
sudo /bin/rm -f -- /usr/local/bin/hvir \
  '/Library/Application Support/hvir/package-inventory-v1.txt'
sudo /bin/rmdir '/Library/Application Support/hvir'
sudo /usr/sbin/pkgutil --forget dev.hvir.app
```

`rmdir` removes the inventory directory only if empty; if it contains other files, leave them
and the directory in place. Forget the receipt only after the app, command, and inventory have
been removed successfully. `pkgutil --forget` alone does **not** remove installed files.
Dragging only the app to Trash leaves the command and receipt behind.

Confirm the three recorded paths are absent and `pkgutil --pkg-info dev.hvir.app` reports no
receipt. Leave `~/Library/Application Support/hvir` and `~/Library/Caches/hvir` untouched: these
are user data, distinct from the system `/Library/Application Support/hvir` inventory directory.
On Linux, similarly preserve `${XDG_CONFIG_HOME:-~/.config}/hvir` and
`${XDG_CACHE_HOME:-~/.cache}/hvir` (absolute XDG roots when configured).

## What the release script does for you

`install.sh` automates target selection, download into a private temporary directory, checksum
verification using its embedded release digest, platform preflight, package operation logging,
and installed-command/receipt and shell-resolution checks. It cleans its temporary downloads
on exit and reports the failing stage. Manual users perform the checks above, retain errors,
and manage their download/extraction folders themselves.

Only the script performs the existing ownership-proven npm migration, derived legacy-cache
cleanup after successful native installation, inventory-checked automatic macOS removal, and
explicit current-user purge. Neither Installer nor APT supplies those script workflows.
The [packaging guide](packaging.md) and
[ADR-042](adr/ADR-042-manual-native-package-installation.md) define the shared release and native
package ownership behind both paths.
