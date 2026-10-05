# Extensions and agents in hvir 0.3

The 0.3 release adds `hvir-skillager-0.3.0.zip` beside the native application packages.
Use the assets of the **same exact release**, download `SHA256SUMS`, and verify the ZIP
using only the exact ZIP entry below. The complete checksum file also names native and metadata
assets; they need not be downloaded to verify the independent ZIP. A missing or duplicate ZIP
entry makes this check fail.

```sh
# Linux
awk '$2 == "hvir-skillager-0.3.0.zip" {line=$0; count++} END {if (count != 1) exit 1; print line}' SHA256SUMS | sha256sum --check -
# macOS
awk '$2 == "hvir-skillager-0.3.0.zip" {line=$0; count++} END {if (count != 1) exit 1; print line}' SHA256SUMS | shasum -a 256 --check -
```

The release manifest identifies the source commit, extension ID, package version, contract
and archive digest. The app installer installs the native application; the ZIP is a separate
ordinary extension package. Skillager itself is installed separately.

## Install and control a package

Choose **Settings → Extensions → Add extension…** and select the completed ZIP or
a ready-to-run directory on macOS. On Linux, select a ZIP or the exact `hvir-extension.json`
inside the package directory. hvir copies the whole selected package, preserves the source
and shows it immediately; no separate Discover is needed. Inspect the package
and access declarations before **Enable**. Duplicate IDs are refused; keep one source form.
Discovery and validation execute no package code. **Disable** closes guests and revokes live
work. **Reload** accepts edited directory/development bytes; **Replace** accepts a selected
ZIP revision. Changed access needs its own trusted approval. A failed replacement keeps the
valid current activation. [Package controls and limits](extensions.md) describe each outcome.

**Remove** moves an ordinary source package to Trash, or removes only a development link.
Keep saved installation identity for reinstall unless you explicitly choose to forget it.
Package files, platform configuration/captured revisions and domain data have separate owners:
removing a package does not delete the Skillager library or project skills. Forgetting identity
ends saved delivery authority while leaving delivered files in place. Inspect retained delivery
recovery in Settings; interrupted work is never replayed automatically.

The [Skillager package guide](../packages/skillager-extension/README.md) covers executable and
read-grant setup, exact acceptance, local copies, explicit terminal setup and SSH Full delivery.
Configure the exact supported public CLI and explicit source roots in Settings. A matching CLI
version alone is insufficient when public contracts are missing. Missing Skillager, pending or
blocked acceptance, unavailable SSH and missing optional native access have visible setup paths;
they do not disable independent document browsing. Reading an unapproved skill does not accept it.

## Use the installed agent command

The native application ships `hvir-agent`, offline guides, the current clock starter, public UI
assets, optional inspectable skill and all four Linux/macOS x64/arm64 SSH clients. Start with:

```sh
hvir-agent commands
hvir-agent guide
hvir-agent guide targeting
hvir-agent guide access
```

In **Settings → Extensions**, explicitly turn on Agent access and enable access for the selected
extension. Connector approval, source grants and harness command/socket permissions stay separate.
The default standing policy permits actions within approved access; optional destructive
confirmation binds the exact delete/replace request. Turning access **Off** revokes pending live
work and SSH forwards. It cannot undo already dispatched effects or remove published reports.

hvir terminals receive nonsecret protected `HVIR_AGENT_ENDPOINT`, `HVIR_AGENT_WORKSPACE` and
`HVIR_AGENT_SESSION`. They select the originating instance and live context, not authentication.
Outside a terminal, `hvir-agent instances`, `workspaces` and `sessions` discover destinations;
use `--instance`, `--workspace` and supported `--session` flags explicitly when needed. Multiple
instances require a selected endpoint. Desktop workspace selection never silently retargets an
admitted request. The installed `help COMMAND` and `action` schema are the command authority.

Publish a finite report without taking focus:

```sh
printf '# Result\n' | hvir-agent report --title Result --format markdown --stdin
```

Outside hvir, supply the exact instance and workspace. A quiet badge appears on the report tab
and aggregates to its workspace/project; viewing clears it. See `guide reports`. Reports are
inert closable views, with ordinary explicit human file-link navigation, and execute no scripts.

For SSH, enable access before starting a fresh terminal. `guide ssh` explains the bundled native
client, supported host requirements, socket/account authority and exact additional action grants.
Disconnect, Off and exit revoke the forward; unknown completion stays unknown. No remote Node or
Python is required. Local offline help and authoring remain available with access Off and hvir closed.

## Make a package without a checkout

Read `hvir-agent guide authoring`, then scaffold a new absolute local directory and validate it:

```sh
hvir-agent scaffold --output /absolute/new-clock
hvir-agent validate --path /absolute/new-clock
```

Edit the ordinary HTML/JS/CSS with your own tools. To produce a ZIP, run
`zip -r /absolute/new-clock.zip .` **inside that directory**, then
`hvir-agent validate --path /absolute/new-clock.zip`. The manifest must be at archive root.
Install the validated directory, ZIP or explicit development link through the ordinary controls
above. Scaffold never enables a package and validation runs no scripts. See `guide manifest`,
`guide ui`, `guide lifetimes`, `guide actions` and `guide connectors` for public authoring contracts.

`hvir-agent skill` inspects the tiny optional shipped skill. `guide skill` explains explicit export
to a new absolute `SKILL.md` and supported harness setup/removal. No skill, terminal banner, startup
message, repository instructions or session hook is injected automatically. A fresh harness with
the explicitly installed skill can use the guides; the skill grants no hvir authority.
