import type { BrowserWindow } from 'electron'

/** Common real preload/main/utility-process prerequisite, retained by every renderer group. */
export async function verifyRendererReadiness(win: BrowserWindow): Promise<void> {
  // A real preload round-trip establishes more than ready-to-show paint.
  const rendererResult = (await win.webContents.executeJavaScript(`
      Promise.all([
        window.hvir.invoke('app:info', undefined),
        window.hvir.invoke('demo:echo', { text: 'renderer-ping' })
      ]).then(([info, echoed]) => ({ info, echoed }))
    `)) as {
    info: { electronVersion: string }
    echoed: { text: string; workerPid: number }
  }
  if (!rendererResult.info.electronVersion) throw new Error('app:info was empty')
  if (rendererResult.echoed.text !== 'renderer-ping') {
    throw new Error(`renderer echo mismatch: ${rendererResult.echoed.text}`)
  }
  if (rendererResult.echoed.workerPid === process.pid) {
    throw new Error('renderer echo ran in the main process')
  }
  console.log('[smoke] renderer IPC + echo worker round-trip OK')
}
