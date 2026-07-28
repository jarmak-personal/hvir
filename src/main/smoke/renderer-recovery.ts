import type { BrowserWindow } from 'electron'

import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'

export async function verifyUnresponsiveRendererRecovery(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly diagnostics: RuntimeDiagnostics
  readonly supervisor: PtySupervisor
  readonly reloadUnresponsiveRenderer: (owner: RendererOwner) => boolean
}): Promise<string> {
  const { win, resources, diagnostics, supervisor, reloadUnresponsiveRenderer } = options
  const initialOwner = resources.currentOwner(win.webContents.id)
  const initialProcessId = win.webContents.getOSProcessId()
  if (supervisor.list().length !== 0) {
    throw new Error('empty renderer-recovery fixture started a PTY before user action')
  }
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )

  if (!reloadUnresponsiveRenderer(initialOwner)) {
    throw new Error('window manager rejected renderer recovery fault injection')
  }
  await timeout(loaded, 'replacement renderer document did not load')

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
  if (
    initialProcessId <= 0 ||
    replacementProcessId <= 0 ||
    initialProcessId === replacementProcessId
  ) {
    throw new Error('renderer recovery did not create a replacement OS process')
  }
  await waitForRecoveryEvidence(diagnostics, initialOwner)
  return (
    `generation ${initialOwner.generation} → ${replacement.generation} · ` +
    `${functionalControl} · empty workspace retained zero PTYs`
  )
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
    const unresponsive = events.find((event) => event.kind === 'renderer-unresponsive')
    const outcomes = events
      .filter((event) => event.kind === 'workbench-health-recovered')
      .map((event) => event['outcome'])
    if (
      unresponsive &&
      outcomes.includes('reload-requested') &&
      outcomes.includes('reload-succeeded')
    ) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('renderer recovery diagnostics did not record request and success')
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
