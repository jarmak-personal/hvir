import { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import { resolveHarnessLaunch } from '../harness/harness-launch'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import { harnessProvider, plainShellProvider } from '../harness/harness-provider'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import { SmokeCleanup } from './cleanup'
import {
  reportSmokeFailureEvidence,
  smokeCleanupResource,
  type SmokeFailurePhase,
} from './failure-evidence.mts'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import { stopPtyAndWaitForExit, waitForPtyOutput } from './pty-lifecycle'

const MAIN_SMOKE_OWNER_ID = 0
const CUSTOM_PROFILE_PROVIDER_ID = 'custom'
const CUSTOM_PROFILE_OUTPUT = 'hvir-profile-smoke:structured'
const MACOS_LOGIN_SHELL = '/bin/zsh'
const MACOS_LOGIN_SHELL_OUTPUT =
  'hvir-login-shell:login|interactive|hvir-login-path-ok|on|on'

/** Exercise production-composed harnesses through Electron's native node-pty ABI. */
export async function runNativePtySmoke(
  projectRoot: HostPath,
  interruptionCheckpoint: SmokeInterruptionCheckpoint,
): Promise<number> {
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  let cleanupFailureResource: ReturnType<typeof smokeCleanupResource> = null
  const profileStorePath = joinHostPath(projectRoot, '.hvir-smoke-native-profile.json')
  const loginShellFixtureRoot = joinHostPath(projectRoot, '.hvir-smoke-login-shell')
  const cleanup = new SmokeCleanup((name) => interruptionCheckpoint.disposed(name), {
    onFailure: (name) => {
      cleanupFailureResource = smokeCleanupResource(name)
      reportSmokeFailureEvidence(
        'cleanup',
        {
          windowCount: BrowserWindow.getAllWindows().length,
          ptyCount: supervisor.list().length,
          watcherActive: false,
          rendererOwnerActive: false,
          rendererGeneration: null,
        },
        null,
        cleanupFailureResource,
      )
    },
  })
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('harness profile fixture', () =>
    host.exec('rm', ['-f', '--', profileStorePath.path]).then(() => undefined),
  )
  cleanup.defer('login shell fixture', () =>
    host.exec('rm', ['-rf', '--', loginShellFixtureRoot.path]).then(() => undefined),
  )
  cleanup.defer('PTY supervisor', () => supervisor.disposeAllAndWait())

  let scenarioFailed = false
  let failurePhase: SmokeFailurePhase = 'resources-created'
  const recordSmokePhase = (phase: SmokeFailurePhase): void => {
    failurePhase = phase
    reportSmokeFailureEvidence(phase, {
      windowCount: BrowserWindow.getAllWindows().length,
      ptyCount: supervisor.list().length,
      watcherActive: false,
      rendererOwnerActive: false,
      rendererGeneration: null,
    })
  }
  recordSmokePhase(failurePhase)
  try {
    assertNoWindows('before native PTY launch')
    await host.connect()
    recordSmokePhase('host-connected')
    await host.exec('rm', ['-f', '--', profileStorePath.path])
    const profiles = await HarnessProfileStore.load(host, profileStorePath)
    recordSmokePhase('profile-loaded')
    const provider = harnessProvider(CUSTOM_PROFILE_PROVIDER_ID)
    const predecessorToken = interruptionCheckpoint.predecessorToken
    const predecessorProfileObserved = Boolean(
      predecessorToken &&
      profiles.list().some((profile) => profile.displayName.includes(predecessorToken)),
    )
    const profile = await profiles.save({
      input: {
        displayName: interruptionCheckpoint.runToken
          ? `Smoke custom harness ${interruptionCheckpoint.runToken}`
          : 'Smoke custom harness',
        providerId: provider.manifest.id,
        scope: { kind: 'project', projectRoot },
        executable: { kind: 'command', command: 'sh' },
        args: [
          { parts: [{ kind: 'literal', value: '-c' }] },
          {
            parts: [
              {
                kind: 'literal',
                // Keep the same noninteractive shell blocked after the sentinel.
                // Replacing its process image here races the production SIGHUP
                // lifecycle with shell startup instead of testing node-pty.
                value:
                  'read trigger; printf hvir-profile-smoke:; printenv HVIR_PROFILE_SMOKE; read hold',
              },
            ],
          },
        ],
        environment: [
          { kind: 'literal', name: 'HVIR_PROFILE_SMOKE', value: 'structured' },
        ],
        pathBindings: [],
        order: 1,
      },
    })
    const acknowledgedProfile = await profiles.acknowledgeRisk(
      profile.id,
      profile.launchRevision,
    )
    if (
      acknowledgedProfile.risk !== 'unclassified' ||
      acknowledgedProfile.riskAcknowledgedRevision !== profile.launchRevision
    ) {
      throw new Error('Custom profile risk acknowledgment was not retained')
    }
    const effectiveCapabilities = {
      sessionIdentity: provider.sessionIdentity,
      exactResume: provider.supportsResume,
      contextPresentation: provider.manifest.contextPresentation,
    }
    const resolved = await resolveHarnessLaunch({
      profile: acknowledgedProfile,
      expectedLaunchRevision: acknowledgedProfile.launchRevision,
      projectRoot,
      workspaceRoot: projectRoot,
      host,
      store: profiles,
      mode: 'fresh',
      context: {
        sessionId: 'custom-profile-pty-smoke',
        cwd: projectRoot,
        cols: 80,
        rows: 24,
        defaultShell: await host.defaultShell(),
        effectiveCapabilities,
      },
    })
    const terminal = await supervisor.spawn({
      host,
      provider: resolved.provider,
      launchSpec: resolved.spec,
      unsetEnvironment: resolved.unsetEnvironment,
      artifact: resolved.artifact,
      effectiveCapabilities,
      cwd: projectRoot,
      workspaceRoot: projectRoot,
      ownerId: MAIN_SMOKE_OWNER_ID,
      sessionId: 'custom-profile-pty-smoke',
      cols: 80,
      rows: 24,
    })
    recordSmokePhase('pty-active')
    if (
      terminal.providerId !== provider.manifest.id ||
      terminal.identityStatus !== 'none' ||
      terminal.resumed
    ) {
      throw new Error('Custom profile PTY identity did not preserve provider semantics')
    }
    await interruptionCheckpoint.reach({
      name: 'profile-pty-ready',
      profileCount: profiles.list().length,
      ptyCount: supervisor.list().length,
      predecessorProfileObserved,
    })
    recordSmokePhase('scenario-active')
    const output = waitForPtyOutput({
      supervisor,
      terminal,
      expected: CUSTOM_PROFILE_OUTPUT,
      scenario: 'custom profile PTY output',
      trigger: () =>
        supervisor.write(terminal.id, terminal.ownerId, 'go\n', terminal.ownerGeneration),
    })
    await output
    await stopPtyAndWaitForExit({
      supervisor,
      terminal,
      scenario: 'custom profile PTY exit',
    })
    if (supervisor.get(terminal.id)) {
      throw new Error(
        `Custom profile PTY remained supervised after exit (pid=${terminal.pid})`,
      )
    }
    await profiles.delete(acknowledgedProfile.id)
    await profiles.flush()
    const loginShellPid =
      process.platform === 'darwin'
        ? await runMacosLoginShellSmoke(
            host,
            supervisor,
            projectRoot,
            loginShellFixtureRoot,
          )
        : undefined
    assertNoWindows('after native PTY exit')
    console.log(
      `[smoke] Custom profile + native node-pty ABI OK (pid ${terminal.pid} · no window)`,
    )
    if (loginShellPid !== undefined) {
      console.log(`[smoke] Bare Shell login environment OK (pid ${loginShellPid})`)
    }
    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (error) {
    scenarioFailed = true
    recordSmokePhase(failurePhase)
    console.error('HVIR_SMOKE_FAIL', error)
    return 1
  } finally {
    try {
      await cleanup.run()
    } catch (cleanupError) {
      reportSmokeFailureEvidence(
        'cleanup',
        {
          windowCount: BrowserWindow.getAllWindows().length,
          ptyCount: supervisor.list().length,
          watcherActive: false,
          rendererOwnerActive: false,
          rendererGeneration: null,
        },
        null,
        cleanupFailureResource,
      )
      console.error('HVIR_SMOKE_CLEANUP_FAIL', cleanupError)
      // A successful scenario must still fail when cleanup does not complete.
      if (!scenarioFailed) {
        // eslint-disable-next-line no-unsafe-finally
        throw cleanupError
      }
    }
  }
}

async function runMacosLoginShellSmoke(
  host: LocalHost,
  supervisor: PtySupervisor,
  projectRoot: HostPath,
  fixtureRoot: HostPath,
): Promise<number> {
  const loginBin = joinHostPath(fixtureRoot, 'login-bin')
  const executable = joinHostPath(loginBin, 'hvir-login-path')
  await host.exec('rm', ['-rf', '--', fixtureRoot.path])
  await host.exec('mkdir', ['-p', '--', loginBin.path])
  await host.writeFile(
    joinHostPath(fixtureRoot, '.zprofile'),
    'export PATH="$HOME/login-bin:$PATH"\n' +
      'export HVIR_LOGIN_STARTUP="${HVIR_LOGIN_STARTUP:+$HVIR_LOGIN_STARTUP,}login"\n',
  )
  await host.writeFile(
    joinHostPath(fixtureRoot, '.zshrc'),
    'export HVIR_INTERACTIVE_STARTUP="${HVIR_INTERACTIVE_STARTUP:+$HVIR_INTERACTIVE_STARTUP,}interactive"\n',
  )
  await host.writeFile(executable, '#!/bin/sh\nprintf hvir-login-path-ok\n')
  await host.exec('chmod', ['0755', executable.path])

  const spec = plainShellProvider.launch({
    sessionId: 'plain-shell-login-smoke',
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    defaultShell: MACOS_LOGIN_SHELL,
  })
  const terminal = await supervisor.spawn({
    host,
    provider: plainShellProvider,
    launchSpec: {
      ...spec,
      env: {
        HOME: fixtureRoot.path,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    },
    cwd: projectRoot,
    workspaceRoot: projectRoot,
    ownerId: MAIN_SMOKE_OWNER_ID,
    sessionId: 'plain-shell-login-smoke',
    cols: 80,
    rows: 24,
  })
  await waitForPtyOutput({
    supervisor,
    terminal,
    expected: MACOS_LOGIN_SHELL_OUTPUT,
    scenario: 'Bare Shell login environment output',
    trigger: () =>
      supervisor.write(
        terminal.id,
        terminal.ownerId,
        `printf 'hvir-login-shell:%s|%s|' "$HVIR_LOGIN_STARTUP" "$HVIR_INTERACTIVE_STARTUP"; hvir-login-path; printf '|%s|%s\\n' "$options[login]" "$options[interactive]"; exit\n`,
        terminal.ownerGeneration,
      ),
  })
  await stopPtyAndWaitForExit({
    supervisor,
    terminal,
    scenario: 'Bare Shell login environment exit',
  })
  if (supervisor.get(terminal.id)) {
    throw new Error(`Bare Shell remained supervised after exit (pid=${terminal.pid})`)
  }
  return terminal.pid
}

function assertNoWindows(phase: string): void {
  const count = BrowserWindow.getAllWindows().length
  if (count !== 0) {
    throw new Error(`${phase}: expected no BrowserWindow, found ${count}`)
  }
}
