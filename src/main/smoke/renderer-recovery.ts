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
import { waitForPtyOutput } from './pty-lifecycle'

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
    checkpoint,
  } = options
  const initialOwner = resources.currentOwner(win.webContents.id)
  if (supervisor.list().length !== 0) {
    throw new Error('empty renderer-recovery fixture started a PTY before user action')
  }
  checkpoint('renderer-recovery-route-opening')
  const route = await timeout(
    routes.open({
      ownerId: initialOwner.id,
      ownerGeneration: initialOwner.generation,
      sourceTerminalId: 'renderer-recovery-rollover',
      workspaceRoot: root,
      host,
      url: 'http://localhost:61337/renderer-recovery',
    }),
    'renderer recovery route did not open',
  )
  checkpoint('renderer-recovery-route-opened')
  const initialPresentation = await timeout(
    win.webContents.capturePage(),
    'renderer recovery initial workbench did not present',
  )
  if (initialPresentation.isEmpty()) {
    throw new Error('renderer recovery initial workbench captured an empty frame')
  }
  const initialProcessId = win.webContents.getOSProcessId()
  if (initialProcessId <= 0) {
    throw new Error('renderer recovery could not identify the presented OS process')
  }
  const localPty = await startRecoveryPty({
    host,
    root,
    id: 'renderer-recovery-local',
    owner: initialOwner,
    resources,
    supervisor,
    sender: win.webContents,
  })
  const syntheticRemoteHost = new SyntheticRemotePtyHost()
  const producerDisposers: Array<() => Promise<void>> = []
  let hasPrimaryFailure = false
  let primaryFailure: unknown
  let result: string | undefined
  try {
    const remotePty = await startRecoveryPty({
      host: syntheticRemoteHost,
      root: hostPath(SYNTHETIC_REMOTE_HOST_ID, root.path),
      id: 'renderer-recovery-ssh',
      owner: initialOwner,
      resources,
      supervisor,
      sender: win.webContents,
    })
    producerDisposers.push(await startPtyProducer(supervisor, localPty, 'local'))
    producerDisposers.push(await startPtyProducer(supervisor, remotePty, 'ssh'))
    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )

    checkpoint('renderer-recovery-reload-awaiting')
    process.kill(initialProcessId, 'SIGKILL')
    await host.writeFile(
      liveReloadPath,
      'renderer recovery stale generation watch event\n',
    )
    await timeout(loaded, 'replacement renderer document did not load')
    checkpoint('renderer-recovery-reload-loaded')

    const replacement = resources.currentOwner(win.webContents.id)
    await installReplacementDeliveryObserver(win, liveReloadPath)
    reattachRecoveryPty(resources, supervisor, localPty, replacement, win.webContents)
    reattachRecoveryPty(resources, supervisor, remotePty, replacement, win.webContents)
    supervisor.write(
      localPty.terminal.id,
      replacement.id,
      "printf 'hvir-replacement-local\\n'\n",
      replacement.generation,
    )
    supervisor.write(
      remotePty.terminal.id,
      replacement.id,
      "printf 'hvir-replacement-ssh\\n'\n",
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
    await waitForReplacementDeliveries(win)

    checkpoint('renderer-recovery-replacement-ipc-awaiting')
    const replacementElectronVersion = (await timeout(
      win.webContents.executeJavaScript(
        `window.hvir.invoke('app:info', undefined).then((info) => info.electronVersion)`,
      ),
      'replacement renderer did not regain IPC authority',
    )) as string
    if (!replacementElectronVersion) {
      throw new Error('replacement renderer returned empty IPC authority evidence')
    }
    checkpoint('renderer-recovery-replacement-ipc-ready')

    checkpoint('renderer-recovery-controls-awaiting')
    const functionalControl = (await timeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const workbench = document.querySelector('.workbench');
          const buttons = [...document.querySelectorAll('.rail-nav button')];
          const files = buttons.find((button) => button.textContent?.trim() === 'Files');
          const harness = buttons.find((button) => button.textContent?.trim() === 'Harness');
          if (workbench && files && harness) {
            harness.click();
            requestAnimationFrame(() => {
              if (harness.getAttribute('aria-current') !== 'page') {
                return reject(new Error('replacement workbench control was not functional'));
              }
              files.click();
              requestAnimationFrame(() => {
                files.getAttribute('aria-current') === 'page'
                  ? resolve('Harness → Files')
                  : reject(new Error('replacement workbench did not restore Files'));
              });
            });
            return;
          }
          if (Date.now() >= deadline) {
            return reject(new Error('replacement workbench controls were unavailable'));
          }
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `),
      'replacement workbench control timed out',
    )) as string
    checkpoint('renderer-recovery-controls-ready')

    checkpoint('renderer-recovery-terminal-lifecycle-awaiting')
    await timeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const emptyAction = [...document.querySelectorAll('.terminal-empty button')]
            .find((button) => button.textContent?.trim() === 'New terminal');
          const sessions = document.querySelectorAll('.terminal-list-row').length;
          const surfaces = document.querySelectorAll('.terminal-surface').length;
          if (emptyAction && sessions === 0 && surfaces === 0) return resolve();
          if (Date.now() >= deadline) {
            return reject(new Error(
              'replacement empty terminal area did not settle: sessions=' + sessions +
              ' surfaces=' + surfaces
            ));
          }
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `),
      'replacement empty terminal lifecycle timed out',
    )
    checkpoint('renderer-recovery-terminal-lifecycle-ready')
    if (supervisor.list().length !== 2) {
      throw new Error('renderer replacement changed the active PTY producer set')
    }

    if (replacement.generation !== initialOwner.generation + 1) {
      throw new Error(
        `renderer recovery advanced ${replacement.generation - initialOwner.generation} generations`,
      )
    }
    const replacementProcessId = win.webContents.getOSProcessId()
    if (replacementProcessId <= 0 || initialProcessId === replacementProcessId) {
      throw new Error('renderer recovery did not create a replacement OS process')
    }
    checkpoint('renderer-recovery-route-revocation-awaiting')
    await waitForCondition(
      () => !routes.has(route.paneId, initialOwner.id, initialOwner.generation),
      'renderer recovery retained its old web route',
    )
    checkpoint('renderer-recovery-route-revoked')
    checkpoint('renderer-recovery-diagnostics-awaiting')
    await waitForRecoveryEvidence(diagnostics, initialOwner)
    checkpoint('renderer-recovery-diagnostics-ready')
    result =
      `killed renderer ${initialProcessId} → ${replacementProcessId} · ` +
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

async function startPtyProducer(
  supervisor: PtySupervisor,
  fixture: RecoveryPtyFixture,
  label: 'local' | 'ssh',
): Promise<() => Promise<void>> {
  const marker = `hvir-${label}-producer-ready`
  await waitForPtyOutput({
    supervisor,
    terminal: fixture.terminal,
    expected: marker,
    scenario: `renderer recovery ${label} producer`,
    trigger: () =>
      supervisor.write(
        fixture.terminal.id,
        fixture.terminal.ownerId,
        `printf '${marker}\\n'; while :; do printf 'hvir-${label}-active\\n'; sleep 0.01; done\n`,
        fixture.terminal.ownerGeneration,
      ),
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    const terminal = supervisor.get(fixture.terminal.id)
    if (!terminal) return
    const stopped = `hvir-${label}-producer-stopped`
    await waitForPtyOutput({
      supervisor,
      terminal,
      expected: stopped,
      scenario: `renderer recovery ${label} producer cleanup`,
      trigger: () =>
        supervisor.write(
          terminal.id,
          terminal.ownerId,
          `\u0003printf '${stopped}\\n'\n`,
          terminal.ownerGeneration,
        ),
    })
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

function installReplacementDeliveryObserver(
  win: BrowserWindow,
  liveReloadPath: HostPath,
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    (() => {
      const expectedWatchPath = ${JSON.stringify(liveReloadPath)};
      const expectedHealthOccurrenceId = ${JSON.stringify(RECOVERY_HEALTH_OCCURRENCE_ID)};
      window.__hvirRendererRecoveryDeliveries = {
        local: false,
        ssh: false,
        watch: false,
        health: false
      };
      window.hvir.on('pty:data', ({ id, data }) => {
        if (id === 'renderer-recovery-local' && data.includes('hvir-replacement-local')) {
          window.__hvirRendererRecoveryDeliveries.local = true;
        }
        if (id === 'renderer-recovery-ssh' && data.includes('hvir-replacement-ssh')) {
          window.__hvirRendererRecoveryDeliveries.ssh = true;
        }
      });
      window.hvir.on('project:watch', ({ path }) => {
        if (path.host === expectedWatchPath.host && path.path === expectedWatchPath.path) {
          window.__hvirRendererRecoveryDeliveries.watch = true;
        }
      });
      window.hvir.on('workbench-health:state', ({ items }) => {
        if (items.some((item) => item.occurrenceId === expectedHealthOccurrenceId)) {
          window.__hvirRendererRecoveryDeliveries.health = true;
        }
      });
    })()
  `)
}

async function waitForReplacementDeliveries(win: BrowserWindow): Promise<void> {
  await timeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const inspect = () => {
          const deliveries = window.__hvirRendererRecoveryDeliveries;
          if (deliveries?.local && deliveries.ssh && deliveries.watch && deliveries.health) {
            return resolve();
          }
          if (Date.now() >= deadline) {
            return reject(new Error(
              'replacement renderer delivery did not settle: ' + JSON.stringify(deliveries)
            ));
          }
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `),
    'replacement renderer event delivery timed out',
  )
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function waitForRecoveryEvidence(
  diagnostics: RuntimeDiagnostics,
  initialOwner: RendererOwner,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const events = diagnostics
      .snapshot()
      .events.filter(
        (event) =>
          event['ownerId'] === initialOwner.id &&
          event.ownerGeneration === initialOwner.generation,
      )
    const exited = events.find(
      (event) => event.kind === 'renderer-process-exited' && event.reason === 'killed',
    )
    if (exited) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('renderer recovery diagnostics did not record the killed process')
}

async function timeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
