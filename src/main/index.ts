/**
 * Main process entry.
 *
 * Wires the process model: creates the window, registers the typed IPC
 * contract, and spawns the echo utility process. Phase 1 ships an empty window;
 * every later feature plugs into the seams instantiated here.
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import { LocalHost } from './project-host'
import { ECHO_REQUEST_TYPE, localPath, type EchoResult } from '../shared'

let echoWorker: WorkerClient | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the OS browser, never in-app (security posture).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev (Vite dev server); in a
  // packaged build we load the built HTML from disk.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function startup(): void {
  echoWorker = createWorkerClient(workerPath('echo-worker.js'), 'hvir-echo')
  registerIpcHandlers({ echoWorker })
  createWindow()

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/**
 * Headless self-check (HVIR_SMOKE=1): stands up the full process model without
 * a human — echo utility process, the typed IPC handlers, LocalHost.exec/stat,
 * and a real window whose renderer round-trips `app:info` back through main —
 * then exits. Run under a display (or `xvfb-run`) so the window can paint.
 */
async function runSmoke(): Promise<number> {
  const worker = createWorkerClient(workerPath('echo-worker.js'), 'hvir-echo-smoke')
  try {
    const echo = await worker.request<EchoResult>(ECHO_REQUEST_TYPE, { text: 'ping' })
    if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
    console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)

    // Register the real IPC handlers so the renderer's app:info resolves — this
    // exercises the whole renderer→main→worker path, not just the seams alone.
    registerIpcHandlers({ echoWorker: worker })

    const host = new LocalHost()
    const result = await host.exec('/bin/echo', ['hvir'])
    if (result.stdout.trim() !== 'hvir')
      throw new Error(`exec mismatch: ${result.stdout}`)
    console.log('[smoke] LocalHost.exec OK')
    // prove host-qualified read works too
    await host.stat(localPath(process.cwd()))
    console.log('[smoke] LocalHost.stat OK')
    await host.dispose()

    const win = createWindow()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('window never became ready')),
        15000,
      )
      win.once('ready-to-show', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    console.log('[smoke] window ready-to-show OK')
    win.destroy()

    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    worker.dispose()
  }
}

void app.whenReady().then(async () => {
  if (process.env['HVIR_SMOKE']) {
    const code = await runSmoke()
    app.exit(code)
    return
  }
  startup()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  echoWorker?.dispose()
})
