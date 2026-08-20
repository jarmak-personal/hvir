import type { BrowserWindow } from 'electron'

import type { HostPath, ProjectState } from '../../shared'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'

/** Prove a live Ghostty surface remounts through the production workspace lifecycle. */
export async function verifyTerminalReconnectRemount(options: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly root: HostPath
  readonly connectedState: ProjectState
  readonly disconnectedState: ProjectState
  readonly emitProjectState: (state: ProjectState) => void
}): Promise<string> {
  const {
    win,
    supervisor,
    resources,
    root,
    connectedState,
    disconnectedState,
    emitProjectState,
  } = options
  const terminal = supervisor
    .list()
    .find((candidate) => candidate.ownerId === win.webContents.id)
  if (!terminal) throw new Error('terminal reconnect fixture was not supervised')

  let outputCallbackFired = false
  let retainedOutputBytes = 0
  const detachProbe = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      outputCallbackFired = true
      retainedOutputBytes = Math.min(
        4_096,
        retainedOutputBytes + Buffer.byteLength(data, 'utf8'),
      )
    },
  })
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      "printf '\\033[41m\\033[2J\\033[H\\033[0m'; sleep 1\n",
    )
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        let lastState = 'canvas missing';
        const poll = () => {
          const canvas = document.querySelector('.terminal-container canvas');
          const context = canvas?.getContext('2d');
          if (canvas && context) {
            const pixel = context.getImageData(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              1,
              1
            ).data;
            const surface = canvas.closest('.terminal-surface');
            const presentation = canvas.closest('.terminal-engine-host')
              ?.__hvirTerminalPerformance;
            const rect = canvas.getBoundingClientRect();
            lastState = 'canvas=' + canvas.width + 'x' + canvas.height +
              ' rect=' + rect.width + 'x' + rect.height +
              ' visibility=' + getComputedStyle(surface).visibility +
              ' pixel=' + [...pixel].join(',') +
              ' presentation=' + JSON.stringify(presentation);
            if (pixel[0] > 120 && pixel[1] < 140) return resolve(true);
          }

          setTimeout(poll, 25);
        };
        poll();
      })
    `)
  } catch (error) {
    console.error(
      `[smoke] PTY probe: ${JSON.stringify({
        outputCallbackFired,
        retainedOutputBytes,
      })}`,
    )
    throw error
  } finally {
    void detachProbe()
  }

  await win.webContents.executeJavaScript(`
    window.__hvirSmokeTerminalCanvas = document.querySelector('.terminal-container canvas');
    window.__hvirSmokeTerminalHost = document.querySelector('.terminal-container');
  `)
  await resources.revokeWorkspace(root)
  emitProjectState(disconnectedState)
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const poll = () => {
        const container = document.querySelector('.terminal-container');
        const status = document.querySelector('.terminal-panel')
          ?.getAttribute('data-terminal-status') || '';
        if (container?.childElementCount === 0 && status === 'disconnected') {
          return resolve(true);
        }

        setTimeout(poll, 25);
      };
      poll();
    })
  `)

  emitProjectState(connectedState)
  const status: unknown = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      let lastState = 'not mounted';
      const poll = () => {
        const canvas = document.querySelector('.terminal-container canvas');
        const host = document.querySelector('.terminal-container');
        const status = document.querySelector('.terminal-panel')
          ?.getAttribute('data-terminal-status') || '';
        lastState = 'status=' + status +
          ' canvas=' + Boolean(canvas) +
          ' host=' + Boolean(host) +
          ' hostRetained=' + (host === window.__hvirSmokeTerminalHost) +
          ' hostConnected=' + Boolean(window.__hvirSmokeTerminalHost?.isConnected);
        if (
          canvas &&
          host &&
          canvas !== window.__hvirSmokeTerminalCanvas &&
          host === window.__hvirSmokeTerminalHost &&
          window.__hvirSmokeTerminalHost?.isConnected &&
          status.startsWith('New shell · pid ')
        ) {
          const context = canvas.getContext('2d');
          const pixel = context?.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1
          ).data;
          lastState = 'status=' + status +
            ' hostRetained=' + (host === window.__hvirSmokeTerminalHost) +
            ' hostConnected=' + Boolean(window.__hvirSmokeTerminalHost?.isConnected) +
            ' pixel=' + (pixel ? [...pixel].join(',') : 'missing');
          if (pixel && pixel[0] < 50 && pixel[1] < 50 && pixel[2] < 60) {
            return resolve(status);
          }
        }

        setTimeout(poll, 25);
      };
      poll();
    })
  `)
  if (typeof status !== 'string') throw new Error('terminal reconnect returned no status')
  return status
}
