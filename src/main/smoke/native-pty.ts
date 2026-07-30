import { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import { resolveHarnessLaunch } from '../harness/harness-launch'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import { harnessProvider } from '../harness/harness-provider'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import { SmokeCleanup } from './cleanup'
import {
  reportSmokeFailureEvidence,
  type SmokeFailurePhase,
} from './failure-evidence.mts'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import { stopPtyAndWaitForExit, waitForPtyOutput } from './pty-lifecycle'

const MAIN_SMOKE_OWNER_ID = 0
const CUSTOM_PROFILE_PROVIDER_ID = 'custom'
const CUSTOM_PROFILE_OUTPUT = 'hvir-profile-smoke:structured'

/** Exercise a production-composed Custom profile through Electron's native node-pty ABI. */
export async function runNativePtySmoke(
  projectRoot: HostPath,
  interruptionCheckpoint: SmokeInterruptionCheckpoint,
): Promise<number> {
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  const profileStorePath = joinHostPath(projectRoot, '.hvir-smoke-native-profile.json')
  const cleanup = new SmokeCleanup((name) => interruptionCheckpoint.disposed(name))
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('harness profile fixture', () =>
    host.exec('rm', ['-f', '--', profileStorePath.path]).then(() => undefined),
  )
  cleanup.defer('PTY supervisor', () => supervisor.disposeAllAndWait())

  let scenarioFailed = false
  let failurePhase: SmokeFailurePhase = 'resources-created'
  try {
    assertNoWindows('before native PTY launch')
    await host.connect()
    failurePhase = 'host-connected'
    await host.exec('rm', ['-f', '--', profileStorePath.path])
    const profiles = await HarnessProfileStore.load(host, profileStorePath)
    failurePhase = 'profile-loaded'
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
                value:
                  'read trigger; printf hvir-profile-smoke:; printenv HVIR_PROFILE_SMOKE; exec /bin/sh',
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
    failurePhase = 'pty-active'
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
    failurePhase = 'scenario-active'
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
    assertNoWindows('after native PTY exit')
    console.log(
      `[smoke] Custom profile + native node-pty ABI OK (pid ${terminal.pid} · no window)`,
    )
    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (error) {
    scenarioFailed = true
    reportSmokeFailureEvidence(failurePhase, {
      windowCount: BrowserWindow.getAllWindows().length,
      ptyCount: supervisor.list().length,
      watcherActive: false,
      rendererOwnerActive: false,
      rendererGeneration: null,
    })
    console.error('HVIR_SMOKE_FAIL', error)
    return 1
  } finally {
    try {
      await cleanup.run()
    } catch (cleanupError) {
      reportSmokeFailureEvidence('cleanup', {
        windowCount: BrowserWindow.getAllWindows().length,
        ptyCount: supervisor.list().length,
        watcherActive: false,
        rendererOwnerActive: false,
        rendererGeneration: null,
      })
      console.error('HVIR_SMOKE_CLEANUP_FAIL', cleanupError)
      // A successful scenario must still fail when cleanup does not complete.
      if (!scenarioFailed) {
        // eslint-disable-next-line no-unsafe-finally
        throw cleanupError
      }
    }
  }
}

function assertNoWindows(phase: string): void {
  const count = BrowserWindow.getAllWindows().length
  if (count !== 0) {
    throw new Error(`${phase}: expected no BrowserWindow, found ${count}`)
  }
}
