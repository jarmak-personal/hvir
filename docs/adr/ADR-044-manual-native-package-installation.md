# ADR-044: Manual installation of existing native packages

> Lifecycle: Active
> Supersedes: [ADR-022](ADR-022-platform-native-github-release-installation.md) | partial | Script-only installation, update, and removal surface and exclusion of direct native package installation.
> Supersedes: [ADR-028](ADR-028-capability-based-debian-linux-installation.md) | partial | Retained single-installer authority for user preparation and lifecycle invocation.

## Context

Some users want to install hvir with familiar native tools without executing a downloaded
shell script. Releases already contain signed and notarized Apple-silicon packages and Linux
x64/arm64 Debian packages. ADR-022 excludes their direct use, and ADR-028 retains the release
installer as the sole preparation and lifecycle surface.

## Decision

Support a documented manual path for clean native installations and updates to existing native
installations. Users select one package and `SHA256SUMS` from one immutable GitHub Release,
download them without elevation, and compare the exact package's SHA-256 digest before invoking
macOS Installer or Linux `apt`. GitHub HTTPS and that release remain the bootstrap trust root;
native package tools do not substitute for the release checksum comparison.

Manual preparation explicitly transfers the release installer's applicable checks to the user:
platform and architecture selection, command and destination ownership, macOS Developer ID
Installer identity, trusted timestamp, stapled notarization ticket and Gatekeeper assessment,
and Linux runtime ABI, dependency simulation and production sandbox capability. Restricted Linux
hosts also require active AppArmor tooling and validation of the verified package's profile
before elevation. No bypass of signing, sandboxing, host policy, or ambiguous ownership is supported.

Native package tools and existing package scripts retain installation, application, command,
and system-integration ownership. macOS Installer installs the complete system package; copying
an app to Applications is not this path. Manual updates repeat preparation for a newer release.
Linux removal uses `apt`; macOS removal checks the existing receipt and package inventory before
removing only their named system files and forgetting the receipt. Both preserve user settings,
registered-project metadata, caches, and project directories. The manual path has no purge mode.

The release-owned `install.sh` remains available for automatic selection, verification, preflight,
command-resolution checks, bounded removal, explicit purge, and the existing legacy npm migration.
Manual installation neither reproduces that migration nor cleans its derived cache. An npm
installation or ambiguous command/destination returns to the existing migration or ownership
resolution workflow before native installation.

Only the script-exclusive surface in ADR-022 and retained single-installer preparation and
invocation authority in ADR-028 are replaced. Their immutable release, signing, privilege,
package ownership, Linux capabilities and acceptance matrix, migration, release atomicity, and
all other unaffected rules remain authoritative. No runtime owner, dependency, package format,
verification tool, update service, or release-publication change is introduced.

## Consequences

Users can manage the existing native packages directly while retaining one artifact and package
ownership contract. They must perform explicit preparation and interpret failures that the
release installer would otherwise handle. The manual guide must stay consistent with the
installer and package lifecycle, and direct manual-flow acceptance must exercise clean install,
update, launch, removal, and user-data preservation on each supported architecture. Script-only
acceptance does not establish the manual user path.

## Rejected alternatives

- Keeping direct package use unsupported: prevents the requested script-free native workflow.
- Skipping manual preflight because native tools validate packages: those tools do not establish
  the release digest, every host capability, or command resolution.
- Adding another installer, verifier, DMG, ZIP, drag-and-drop path, package manager, or runtime
  owner: existing release packages already supply the required system integration.
- Reimplementing npm migration or manual purge: these remain bounded responsibilities of the
  existing release installer.
