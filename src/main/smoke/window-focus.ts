import { app, type BrowserWindow } from 'electron'

/** Acquire real Chromium focus before a smoke exercises clipboard or surface leases. */
export async function focusSmokeWindow(win: BrowserWindow): Promise<void> {
  win.show()
  const deadline = Date.now() + 5000
  while (!((await win.webContents.executeJavaScript('document.hasFocus()')) as boolean)) {
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    if (Date.now() > deadline) throw new Error('Smoke window did not acquire focus')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
