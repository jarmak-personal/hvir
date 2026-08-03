import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

export async function verifyRendererProcessRecovery(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly diagnostics: RuntimeDiagnostics
  readonly supervisor: PtySupervisor
  readonly routes: WebPaneRouteRegistry
  readonly root: HostPath
  readonly host: ProjectHost
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<string> {
  const { win, resources, diagnostics, supervisor, routes, root, host, checkpoint } =
    options
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
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )

  checkpoint('renderer-recovery-reload-awaiting')
  process.kill(initialProcessId, 'SIGKILL')
  await timeout(loaded, 'replacement renderer document did not load')
  checkpoint('renderer-recovery-reload-loaded')

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
  if (supervisor.list().length !== 0) {
    throw new Error('renderer replacement implicitly started a PTY')
  }

  const replacement = resources.currentOwner(win.webContents.id)
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
  return (
    `killed renderer ${initialProcessId} → ${replacementProcessId} · ` +
    `generation ${initialOwner.generation} → ${replacement.generation} · ` +
    `${functionalControl} · old route revoked · empty workspace retained zero PTYs`
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
