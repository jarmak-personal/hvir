# macOS LAN SSH coexistence acceptance

Raw `npm run dev` remains the ordinary hot-reload workflow. It uses upstream Electron identity and
is not evidence for macOS LAN SSH permission behavior. The general `npm run build:dir` command can
also produce an unsigned local bundle and is not an SSH acceptance path. Use the repository-owned
signed acceptance application whenever Local Network Privacy is part of the test.

The acceptance application is contributor tooling, not an installation or release surface. It is
built under `dist/ssh-acceptance`, carries bundle ID `dev.hvir.ssh-acceptance`, and uses the
`hvir-ssh-acceptance` application-data directory. The installed release remains
`dev.hvir.app` at `/Applications/hvir.app` with its existing release state.

## Protected prerequisites

Run on Apple-silicon macOS from a clean user account or a VM snapshot whose Local Network
permissions can be restored. Install the Developer ID signed hvir release through the supported
release installer. A LAN SSH target must be explicitly configured in each application; do not
substitute an ambient SSH agent, default host, or raw TCP probe.

The build requires these protected values:

- `MACOS_APPLICATION_CERTIFICATE`: electron-builder-compatible Developer ID Application
  certificate;
- `MACOS_APPLICATION_CERTIFICATE_PASSWORD`: its password; and
- `MACOS_TEAM_ID`: the expected ten-character Apple Developer Team ID.

Build without launching:

```sh
npm run build:macos:ssh-acceptance
```

Build and directly launch the exact signed application:

```sh
npm run acceptance:ssh:macos
```

The second command is the required launch path from a terminal inside the running release. It
checks the bundle identifier, Developer ID signing class, Team ID, designated requirement,
main-executable UUID, and Local Network usage description before launch. Missing signing input,
an unsigned or ad-hoc bundle, a mismatched Team ID, or incomplete identity evidence stops the
command; it never launches `npm run dev`, raw Electron, or an unsigned fallback. Signing inputs
are removed from the launched application's environment.

## Coexistence matrix

From one clean permission state, launch the installed release first. Grant its Local Network
access and connect the LAN SSH project. From a terminal in that running release, run
`npm run acceptance:ssh:macos`, grant the separately named acceptance application access, and
connect the same target.

With both copies running, exercise three fresh transports in each application:

1. disconnect and reconnect the SSH host;
2. close and reopen the remote project; and
3. quit and relaunch the application, then reopen the project.

After each operation, confirm both copies can create a fresh connection and a control `ssh`
command from Terminal still reaches the target.

Restore a separate clean permission state and repeat with the signed acceptance application
launched first, then the installed release launched second. A prior successful permission state
does not satisfy the reverse-order check.

Record the bounded identity facts for both exact tested bundles:

```sh
npm run acceptance:ssh:macos:identity -- \
  --release /Applications/hvir.app \
  --acceptance 'dist/ssh-acceptance/mac-arm64/hvir SSH Acceptance.app'
```

The command prints only the bundle ID, signing class, Team ID, designated requirement,
main-executable UUID, and Local Network usage description for each copy. Record the clean-state
coexistence outcome with the governing issue or pull request; do not add acceptance logs to an
ADR. Diagnostic reports remain bounded and content-free and identify their compiled `release` or
`ssh-acceptance` channel without revealing the selected user-data path.
