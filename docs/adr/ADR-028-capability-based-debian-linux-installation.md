# ADR-028: Capability-based Debian Linux installation

> Lifecycle: Active
> Supersedes: [ADR-022](ADR-022-platform-native-github-release-installation.md) | partial | Linux support matrix and unconditional Ubuntu AppArmor integration.

## Context

ADR-022 selected one release-owned installer and verified native artifacts, but its Linux
matrix made Ubuntu 24.04 the exclusive support boundary. Ubuntu 24.04 was the environment that
required native AppArmor integration for Chromium's user-namespace sandbox; its distribution
identity and version were not application requirements. The resulting installer rejected other
compatible Debian-package hosts before evaluating their package manager, runtime ABI, libraries,
or sandbox capabilities.

Replacing the exact Ubuntu check with `ID`, `ID_LIKE`, or version allowlists would preserve the
same identity-based policy with a wider aperture. Linux compatibility needs to follow the
released Electron binary, hvir's native PTY, the `.deb` dependencies, and Chromium's production
sandbox instead.

This record supersedes only ADR-022's Linux support matrix and unconditional Ubuntu AppArmor
framing. ADR-022 continues to own the single installer, immutable GitHub Release, verified native
artifacts, privilege boundary, package-manager lifecycle, migration, and release atomicity.

## Decision

hvir supports Linux x64 and arm64 hosts that provide:

- Bash, `sudo`, the Debian `dpkg` and `apt` tools, and configured repositories capable of
  resolving the verified package's dependencies;
- glibc 2.35 or newer and libstdc++6 from GCC 12 or newer, matching the oldest native build and
  acceptance baseline;
- the package-declared desktop system libraries; and
- a production Chromium sandbox through unprivileged user namespaces, the package-owned setuid
  sandbox helper, or the package-owned AppArmor user-namespace integration when the host kernel
  requires it.

The release installer makes support decisions from those capabilities. It does not use `ID`,
`ID_LIKE`, `VERSION_ID`, or another distribution/version allowlist. Before elevation it checks
the runtime ABI and sandbox path, downloads and verifies the exact release artifact, asks `apt`
to simulate dependency resolution, and validates the packaged AppArmor profile when the active
kernel policy requires that integration. A missing capability is reported before the privileged
package operation changes the system.

The `.deb` keeps its AppArmor policy as an auditable package resource but does not require
AppArmor on every host. The maintainer scripts install and load the profile only when
`apparmor_restrict_unprivileged_userns` is active, remove stale package-owned profile state when
that integration is not required, and remove loaded package state on uninstall. They retain the
root-owned setuid sandbox helper when an unprivileged user-namespace probe fails. Production
launch never disables Chromium sandboxing and never asks the user to change global AppArmor or
sysctl policy.

Release Linux artifacts are built natively on Ubuntu 22.04 for each architecture so hvir's
rebuilt native PTY cannot acquire a newer glibc baseline than the declared floor. The same exact
artifacts receive installed-package acceptance on Ubuntu 22.04, Ubuntu 24.04, and the current
Debian stable userspace on both x64 and arm64. Ubuntu 24.04 remains the required AppArmor
integration case; the other matrix entries prove that AppArmor 4 policy is not an unconditional
package requirement.

## Consequences

Compatible Debian-package derivatives and future releases are accepted without adding their
identity to hvir. Compatibility failures name a missing tool, ABI, dependency, or sandbox
capability before package installation. The support claim is narrower than "all Debian-family
Linux": non-Debian package managers, other architectures, older ABIs, unresolvable library sets,
and hosts without a usable production sandbox remain unsupported.

The continuing matrix is more expensive because each released Linux architecture is exercised
across three userspaces. A future Electron, native dependency, Debian stable release, or sandbox
policy change must update the measured floor and acceptance evidence together rather than
silently narrowing support through a new identity gate.

## Rejected alternatives

- Accepting `ID=ubuntu`, `ID=debian`, or `ID_LIKE=debian`; derivatives can omit or broaden those
  metadata values without changing any runtime capability.
- Allowing exact versions from a growing distribution allowlist; future compatible releases
  would fail for identity alone.
- Keeping AppArmor as an unconditional `.deb` dependency; older AppArmor versions cannot parse
  the Ubuntu 24.04 user-namespace policy and unrestricted hosts do not need it.
- Disabling Chromium's sandbox or asking users to change global AppArmor or sysctl policy.
- Building release artifacts on a newer distribution and treating tests of separately rebuilt
  artifacts on the oldest distribution as ABI evidence.
