import type { BrowserWindow } from 'electron'

import type { TerminalRecoverySession } from '../../shared'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { runCleanupTaskWithinDeadline } from './cleanup'
import type { PtySupervisor } from '../pty/pty-supervisor'

export async function verifyRendererRolloverRecovery(options: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly setRecoverySessions: (sessions: readonly TerminalRecoverySession[]) => void
}): Promise<string> {
  const { win, supervisor, setRecoverySessions } = options
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
    const activeRuntimeId = (await win.webContents.executeJavaScript(`
      document.querySelector('.terminal-surface.active')
        ?.getAttribute('data-terminal-session')
    `)) as string | null
    const retained = activeRuntimeId ? supervisor.get(activeRuntimeId) : undefined
    if (!retained?.profileId || retained.launchRevision === undefined) {
      throw new Error('renderer rollover lacked an active runtime-owned PTY')
    }
    setRecoverySessions([
      {
        id: retained.id,
        providerId: retained.providerId,
        profileId: retained.profileId,
        launchRevision: retained.launchRevision,
        recoverySkipCount: 0,
        harnessSessionId: retained.harnessSessionId,
        hostId: retained.hostId,
        cwd: retained.cwd,
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
    await reloaded
    const recoveryStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
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

                    setTimeout(waitForTerminal, 25);
                  };
                  waitForTerminal();
                });
              });
              return;
            }
            setTimeout(waitForDialog, 25);
          };
          waitForDialog();
        })
      `)) as string
    const recovered = supervisor.get(retained.id)
    if (
      recovered?.pid !== retained.pid ||
      recovered.instanceId !== retained.instanceId ||
      recovered.ownerGeneration <= retained.ownerGeneration
    ) {
      throw new Error('renderer reload replaced the active runtime PTY')
    }
    return `${recoveryStatus} · active runtime retained PTY ${retained.id}`
  } finally {
    await restoreStorage(win, 'hvir:terminal-recovery-mode', previousRecoveryMode)
    await restoreStorage(win, 'hvir:settings:v1', previousSettings)
  }
}

export async function verifyTerminalRendererDestruction(options: {
  readonly win: BrowserWindow
  readonly initialGeneration: number
  readonly resources: RendererResourceScopes
  readonly supervisor: PtySupervisor
}): Promise<void> {
  const { win, initialGeneration, resources, supervisor } = options
  const owner = resources.currentOwner(win.webContents.id)
  if (owner.generation <= initialGeneration) {
    throw new Error('renderer reload did not advance its resource generation')
  }

  const destroyed = new Promise<void>((resolve) =>
    win.webContents.once('destroyed', () => resolve()),
  )
  win.destroy()
  await runCleanupTaskWithinDeadline(async () => {
    await destroyed
    await waitFor(() => supervisor.list().length === 0)
  })
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

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
