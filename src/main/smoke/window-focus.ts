import { app, type BrowserWindow } from 'electron'

/** Acquire real Chromium focus before a smoke exercises clipboard or surface leases. */
export async function focusSmokeWindow(
  win: BrowserWindow,
  target: 'document' | 'window' = 'document',
): Promise<void> {
  win.show()
  const deadline = Date.now() + 5000
  const focused = async (): Promise<boolean> =>
    target === 'window'
      ? win.isVisible() && win.isFocused() && !win.isMinimized()
      : ((await win.webContents.executeJavaScript('document.hasFocus()')) as boolean)
  while (!(await focused())) {
    app.focus({ steal: true })
    win.focus()
    if (target === 'document') win.webContents.focus()
    if (Date.now() > deadline) throw new Error('Smoke window did not acquire focus')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
