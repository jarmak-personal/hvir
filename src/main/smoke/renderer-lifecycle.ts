import type { BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  type HarnessProviderId,
  type TerminalRecoverySession,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { HostPath } from '../../shared'

export async function verifyRendererRolloverRecovery(options: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly root: HostPath
  readonly providerId: HarnessProviderId
  readonly setRecoverySessions: (sessions: readonly TerminalRecoverySession[]) => void
}): Promise<string> {
  const { win, supervisor, root, providerId, setRecoverySessions } = options
  const previousRecoveryMode = (await win.webContents.executeJavaScript(
    `localStorage.getItem('hvir:terminal-recovery-mode')`,
  )) as string | null
  const previousSettings = (await win.webContents.executeJavaScript(
    `localStorage.getItem('hvir:settings:v1')`,
  )) as string | null
  try {
    await win.webContents.executeJavaScript(
      `localStorage.setItem('hvir:terminal-recovery-mode', 'prompt'); localStorage.setItem('hvir:settings:v1', JSON.stringify({ terminalRecoveryMode: 'prompt' }))`,
    )
    const retainedStart = (await win.webContents.executeJavaScript(`
      window.hvir.invoke('pty:start', {
        sessionId: 'smoke-recovery-shell',
        profileId: 'plain-shell-default',
        launchRevision: 1,
        cwd: ${JSON.stringify(root)},
        cols: 80,
        rows: 24,
        title: 'Recovered smoke shell',
        position: 0,
        active: true,
        composerSubmitMode: 'enter',
        resume: false
      })
    `)) as { outcome: string; pid?: number }
    if (retainedStart.outcome !== 'started' || retainedStart.pid === undefined) {
      throw new Error('renderer rollover PTY fixture did not start')
    }
    const retainedPid = retainedStart.pid
    setRecoverySessions([
      {
        id: 'smoke-recovery-shell',
        providerId,
        profileId: asHarnessProfileId('plain-shell-default'),
        launchRevision: 1,
        recoverySkipCount: 0,
        hostId: root.hostId,
        cwd: root,
        title: 'Recovered smoke shell',
        position: 0,
        active: true,
        updatedAt: Date.now(),
      },
    ])
    const reloaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    win.webContents.reload()
    await timeout(reloaded, 'recovery smoke reload timed out')
    const recoveryStatus = (await timeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const waitForDialog = () => {
            const dialog = document.querySelector('.terminal-recovery-dialog');
            const option = dialog?.querySelector('.terminal-recovery-option input');
            if (option) {
              option.click();
              requestAnimationFrame(() => {
                if (!document.querySelector('.terminal-recovery-dialog')) {
                  return reject(new Error('recovery dialog crashed after changing selection'));
                }
                if (option.checked) {
                  return reject(new Error('recovery option did not clear'));
                }
                option.click();
                requestAnimationFrame(() => {
                  if (!option.checked) {
                    return reject(new Error('recovery option did not reselect'));
                  }
                  const restore = [...dialog.querySelectorAll('button')]
                    .find((node) => node.textContent?.trim() === 'Restore selected');
                  restore?.click();
                  const waitForTerminal = () => {
                    const status = document.querySelector('.terminal-panel')?.getAttribute('data-terminal-status') || '';
                    const gitReady = [...document.querySelectorAll('.git-tabs button')]
                      .some((node) => /^Changes \\(\\d+\\)$/.test(node.textContent?.trim() || ''));
                    if (status.startsWith('Reattached · pid ') && gitReady) {
                      return resolve('toggle selection · restore · ' + status);
                    }
                    if (Date.now() > deadline) {
                      return reject(new Error('restored workspace did not settle: ' + status));
                    }
                    setTimeout(waitForTerminal, 25);
                  };
                  waitForTerminal();
                });
              });
              return;
            }
            if (Date.now() > deadline) return reject(new Error('recovery dialog missing'));
            setTimeout(waitForDialog, 25);
          };
          waitForDialog();
        })
      `),
      'terminal recovery interaction timed out',
      12_000,
    )) as string
    if (supervisor.get('smoke-recovery-shell')?.pid !== retainedPid) {
      throw new Error('renderer reload replaced the retained PTY process')
    }
    return recoveryStatus
  } finally {
    await restoreStorage(win, 'hvir:terminal-recovery-mode', previousRecoveryMode)
    await restoreStorage(win, 'hvir:settings:v1', previousSettings)
  }
}

export async function verifyRendererLifecycleCleanup(options: {
  readonly win: BrowserWindow
  readonly initialGeneration: number
  readonly resources: RendererResourceScopes
  readonly routes: WebPaneRouteRegistry
  readonly supervisor: PtySupervisor
  readonly root: HostPath
  readonly host: ProjectHost
}): Promise<void> {
  const { win, initialGeneration, resources, routes, supervisor, root, host } = options
  const owner = resources.currentOwner(win.webContents.id)
  if (owner.generation <= initialGeneration) {
    throw new Error('renderer reload did not advance its resource generation')
  }
  const route = await routes.open({
    ownerId: owner.id,
    ownerGeneration: owner.generation,
    sourceTerminalId: supervisor.list()[0]?.id ?? 'smoke-recovery-shell',
    workspaceRoot: root,
    host,
    url: 'http://localhost:61337/renderer-destruction',
  })
  if (!routes.has(route.paneId, owner.id, owner.generation)) {
    throw new Error('renderer-owned web route was not registered')
  }

  const destroyed = new Promise<void>((resolve) =>
    win.webContents.once('destroyed', () => resolve()),
  )
  win.destroy()
  await timeout(destroyed, 'window webContents was not destroyed')
  await waitFor(
    () => !routes.has(route.paneId, owner.id, owner.generation),
    'webContents destruction left an owner web route alive',
  )
  if (supervisor.list().length !== 0) {
    throw new Error('window close left an orphaned PTY')
  }
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

async function restoreStorage(
  win: BrowserWindow,
  key: string,
  previous: string | null,
): Promise<void> {
  if (previous === null) {
    await win.webContents.executeJavaScript(
      `localStorage.removeItem(${JSON.stringify(key)})`,
    )
  } else {
    await win.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(previous)})`,
    )
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
