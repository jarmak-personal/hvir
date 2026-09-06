import {
  installReplacementDeliveryObserver,
  waitForReplacementDeliveries,
} from './renderer-recovery-delivery'
import type { BrowserWindow } from 'electron'

import { asHostId, hostPath, type HostPath } from '../../shared'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import { plainShellProvider } from '../harness/harness-provider'
import type { ProjectHost } from '../project-host'
import { LocalHost } from '../project-host/local-host'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import {
  attachRendererPty,
  registerRendererPty,
  rendererPtyQualifier,
} from '../terminal/renderer-pty-lifecycle'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'
import { startPtyProducer } from './renderer-recovery-producer'

const SYNTHETIC_REMOTE_HOST_ID = asHostId('smoke-renderer-recovery-ssh')
const RECOVERY_HEALTH_OCCURRENCE_ID = '019c0000-0000-7000-8000-000000000287'

interface RecoveryPtyFixture {
  readonly root: HostPath
  readonly terminal: ManagedPty
}

export async function verifyRendererProcessRecovery(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly diagnostics: RuntimeDiagnostics
  readonly supervisor: PtySupervisor
  readonly routes: WebPaneRouteRegistry
  readonly root: HostPath
  readonly liveReloadPath: HostPath
  readonly host: ProjectHost
  readonly replacementReady: Promise<RendererOwner>
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<string> {
  const {
    win,
    resources,
    diagnostics,
    supervisor,
    routes,
    root,
    liveReloadPath,
    host,
    replacementReady,
    checkpoint,
  } = options
  const initialOwner = resources.currentOwner(win.webContents.id)
  if (supervisor.list().length !== 0) {
    throw new Error('empty renderer-recovery fixture started a PTY before user action')
  }
  checkpoint('renderer-recovery-route-opening')
  const route = await routes.open({
    ownerId: initialOwner.id,
    ownerGeneration: initialOwner.generation,
    sourceTerminalId: 'renderer-recovery-rollover',
    workspaceRoot: root,
    host,
    url: 'http://localhost:61337/renderer-recovery',
  })
  checkpoint('renderer-recovery-route-opened')
  // The shared smoke harness has already observed ready-to-show and completed a
  // preload IPC round-trip. capturePage() adds no recovery-specific evidence here,
  // and its native implementation can synchronously stall Electron under Xvfb.
  checkpoint('renderer-recovery-process-query-awaiting')
  const initialProcessId = win.webContents.getOSProcessId()
  if (initialProcessId <= 0) {
    throw new Error('renderer recovery could not identify the presented OS process')
  }
  checkpoint('renderer-recovery-local-pty-awaiting')
  const localPty = await startRecoveryPty({
    host,
    root,
    id: 'renderer-recovery-local',
    owner: initialOwner,
    resources,
    supervisor,
    sender: win.webContents,
  })
  checkpoint('renderer-recovery-local-pty-ready')
  const syntheticRemoteHost = new SyntheticRemotePtyHost()
  const producerDisposers: Array<() => Promise<void>> = []
  let hasPrimaryFailure = false
  let primaryFailure: unknown
  let result: string | undefined
  try {
    checkpoint('renderer-recovery-remote-pty-awaiting')
    const remotePty = await startRecoveryPty({
      host: syntheticRemoteHost,
      root: hostPath(SYNTHETIC_REMOTE_HOST_ID, root.path),
      id: 'renderer-recovery-ssh',
      owner: initialOwner,
      resources,
      supervisor,
      sender: win.webContents,
    })
    checkpoint('renderer-recovery-remote-pty-ready')
    checkpoint('renderer-recovery-producers-awaiting')
    producerDisposers.push(await startPtyProducer(supervisor, localPty, 'local'))
    producerDisposers.push(await startPtyProducer(supervisor, remotePty, 'ssh'))
    checkpoint('renderer-recovery-producers-ready')
    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    const rendererGone = new Promise<Electron.RenderProcessGoneDetails>((resolve) =>
      win.webContents.once('render-process-gone', (_event, details) => resolve(details)),
    )

    checkpoint('renderer-recovery-reload-awaiting')
    checkpoint('renderer-recovery-crash-call-awaiting')
    win.webContents.forcefullyCrashRenderer()
    checkpoint('renderer-recovery-crash-call-returned')
    await host.writeFile(
      liveReloadPath,
      'renderer recovery stale generation watch event\n',
    )
    const exit = await rendererGone
    if (exit.reason !== 'killed' && exit.reason !== 'crashed') {
      throw new Error(`forced renderer crash exited with ${exit.reason}`)
    }
    await loaded
    checkpoint('renderer-recovery-reload-loaded')

    checkpoint('renderer-recovery-readiness-awaiting')
    const replacement = await replacementReady
    if (
      replacement.id !== initialOwner.id ||
      replacement.generation !== initialOwner.generation + 1
    ) {
      throw new Error(
        `renderer recovery accepted unexpected owner ${replacement.id}:${replacement.generation}`,
      )
    }
    checkpoint('renderer-recovery-readiness-ready')
    checkpoint('renderer-recovery-observer-awaiting')
    await installReplacementDeliveryObserver(
      win.webContents,
      liveReloadPath,
      RECOVERY_HEALTH_OCCURRENCE_ID,
    )
    checkpoint('renderer-recovery-observer-ready')
    checkpoint('renderer-recovery-reattach-awaiting')
    reattachRecoveryPty(resources, supervisor, localPty, replacement, win.webContents)
    reattachRecoveryPty(resources, supervisor, remotePty, replacement, win.webContents)
    checkpoint('renderer-recovery-reattach-ready')
    // Continuous output spans the crash and ownership transfer. Return both live
    // shells to their prompts before asking them to execute replacement commands.
    checkpoint('renderer-recovery-producer-stop-awaiting')
    for (const stopProducer of [...producerDisposers].reverse()) await stopProducer()
    checkpoint('renderer-recovery-producer-stop-ready')
    supervisor.write(
      localPty.terminal.id,
      replacement.id,
      "printf 'hvir-replacement-%s\\n' 'local'\n",
      replacement.generation,
    )
    supervisor.write(
      remotePty.terminal.id,
      replacement.id,
      "printf 'hvir-replacement-%s\\n' 'ssh'\n",
      replacement.generation,
    )
    await host.writeFile(liveReloadPath, 'renderer recovery replacement watch event\n')
    diagnostics.recordWindowHealth({
      kind: 'renderer-unresponsive',
      ownerId: replacement.id,
      ownerGeneration: replacement.generation,
      occurrenceId: RECOVERY_HEALTH_OCCURRENCE_ID,
    })
    diagnostics.recordWindowHealth({
      kind: 'workbench-health-recovered',
      ownerId: replacement.id,
      ownerGeneration: replacement.generation,
      occurrenceId: RECOVERY_HEALTH_OCCURRENCE_ID,
      outcome: 'responsive',
    })
    checkpoint('renderer-recovery-deliveries-awaiting')
    await waitForReplacementDeliveries(win.webContents)
    checkpoint('renderer-recovery-deliveries-ready')

    checkpoint('renderer-recovery-replacement-ipc-awaiting')
    const replacementElectronVersion = (await win.webContents.executeJavaScript(
      `window.hvir.invoke('app:info', undefined).then((info) => info.electronVersion)`,
    )) as string
    if (!replacementElectronVersion) {
      throw new Error('replacement renderer returned empty IPC authority evidence')
    }
    checkpoint('renderer-recovery-replacement-ipc-ready')

    checkpoint('renderer-recovery-controls-awaiting')
    const functionalControl = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const inspect = () => {
          const workbench = document.querySelector('.workbench');
          const buttons = [...document.querySelectorAll('.rail-nav button')];
          const files = buttons.find((button) => button.textContent?.trim() === 'Files');
          const sessions = document.querySelector('.sessions-destination');
          const project = document.querySelector('.project-tab-main');
          if (workbench && files && sessions && project instanceof HTMLButtonElement) {
            sessions.click();
            const restoreWorkspace = () => {
              if (sessions.getAttribute('aria-current') === 'page' && workbench.hidden) {
                project.click();
                const confirmFiles = () => {
                  if (files.getAttribute('aria-current') === 'page' && !workbench.hidden) {
                    return resolve('Sessions → project → Files');
                  }
                  if (Date.now() > deadline) {
                    return reject(new Error('replacement workbench did not restore Files'));
                  }
                  requestAnimationFrame(confirmFiles);
                };
                requestAnimationFrame(confirmFiles);
                return;
              }
              if (Date.now() > deadline) {
                return reject(new Error('replacement workbench control was not functional'));
              }
              requestAnimationFrame(restoreWorkspace);
            };
            requestAnimationFrame(restoreWorkspace);
            return;
          }
          if (Date.now() > deadline) {
            return reject(new Error('replacement workbench controls did not become ready'));
          }
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `)) as string
    checkpoint('renderer-recovery-controls-ready')

    checkpoint('renderer-recovery-terminal-lifecycle-awaiting')
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const inspect = () => {
          const emptyAction = [...document.querySelectorAll('.terminal-empty button')]
            .find((button) => button.textContent?.trim() === 'New terminal');
          const sessions = document.querySelectorAll('.terminal-list-row').length;
          const surfaces = document.querySelectorAll('.terminal-surface').length;
          if (emptyAction && sessions === 0 && surfaces === 0) return resolve();
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `)
    checkpoint('renderer-recovery-terminal-lifecycle-ready')
    if (supervisor.list().length !== 2) {
      throw new Error('renderer replacement changed the active PTY producer set')
    }

    const replacementProcessId = win.webContents.getOSProcessId()
    if (replacementProcessId <= 0 || initialProcessId === replacementProcessId) {
      throw new Error('renderer recovery did not create a replacement OS process')
    }
    checkpoint('renderer-recovery-route-revocation-awaiting')
    await waitForCondition(
      () => !routes.has(route.paneId, initialOwner.id, initialOwner.generation),
    )
    checkpoint('renderer-recovery-route-revoked')
    checkpoint('renderer-recovery-diagnostics-awaiting')
    await waitForRecoveryEvidence(
      diagnostics,
      initialOwner,
      exit.reason === 'killed' ? 'killed' : 'crashed',
    )
    checkpoint('renderer-recovery-diagnostics-ready')
    result =
      `forced renderer crash ${initialProcessId} → ${replacementProcessId} · ` +
      `generation ${initialOwner.generation} → ${replacement.generation} · ` +
      `${functionalControl} · old route revoked · ` +
      `local/remote-qualified PTYs, watch, and health delivered`
  } catch (error) {
    hasPrimaryFailure = true
    primaryFailure = error
  }

  const cleanupFailures: unknown[] = []
  for (const dispose of producerDisposers.reverse()) {
    try {
      await dispose()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  try {
    await syntheticRemoteHost.dispose()
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (cleanupFailures.length > 0) {
    const cleanupError = new AggregateError(
      cleanupFailures,
      'renderer recovery producer cleanup failed',
    )
    if (!hasPrimaryFailure) throw cleanupError
    console.error('[smoke] renderer recovery cleanup failed', cleanupError)
  }
  if (hasPrimaryFailure) throw primaryFailure
  if (!result) throw new Error('renderer recovery completed without evidence')
  return result
}

/**
 * Supplies a host-qualified remote producer after the transport boundary. The renderer
 * delivery contract is host-neutral; deterministic SshHost transport remains at its own seam.
 */
class SyntheticRemotePtyHost extends LocalHost {
  override readonly hostId = SYNTHETIC_REMOTE_HOST_ID
  override readonly watchTier = 'polling' as const
}

async function startRecoveryPty(options: {
  readonly host: ProjectHost
  readonly root: HostPath
  readonly id: string
  readonly owner: RendererOwner
  readonly resources: RendererResourceScopes
  readonly supervisor: PtySupervisor
  readonly sender: BrowserWindow['webContents']
}): Promise<RecoveryPtyFixture> {
  const { host, root, id, owner, resources, supervisor, sender } = options
  const dependencies = {
    rendererResources: resources,
    ptySupervisor: supervisor,
  }
  const lease = registerRendererPty(dependencies, owner, root, id)
  try {
    const terminal = await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: root,
      workspaceRoot: root,
      ownerId: owner.id,
      ownerGeneration: owner.generation,
      sessionId: id,
      cols: 80,
      rows: 24,
    })
    attachRendererPty(dependencies, terminal, lease, owner, sender)
    return { root, terminal }
  } catch (error) {
    await lease.dispose()
    throw error
  }
}

function reattachRecoveryPty(
  resources: RendererResourceScopes,
  supervisor: PtySupervisor,
  fixture: RecoveryPtyFixture,
  owner: RendererOwner,
  sender: BrowserWindow['webContents'],
): void {
  const lease = resources.claimTransferredResource(
    owner,
    rendererPtyQualifier(fixture.root, fixture.terminal.id),
  )
  const terminal = supervisor.get(fixture.terminal.id)
  if (!lease || !terminal) {
    throw new Error(`renderer recovery did not transfer ${fixture.terminal.id}`)
  }
  attachRendererPty(
    { rendererResources: resources, ptySupervisor: supervisor },
    terminal,
    lease,
    owner,
    sender,
  )
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (;;) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForRecoveryEvidence(
  diagnostics: RuntimeDiagnostics,
  initialOwner: RendererOwner,
  expectedReason: 'crashed' | 'killed',
): Promise<void> {
  for (;;) {
    const events = diagnostics
      .snapshot()
      .events.filter(
        (event) =>
          event['ownerId'] === initialOwner.id &&
          event.ownerGeneration === initialOwner.generation,
      )
    const exited = events.find(
      (event) =>
        event.kind === 'renderer-process-exited' && event.reason === expectedReason,
    )
    if (exited) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
