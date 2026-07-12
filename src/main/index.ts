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
import { PtySupervisor } from './pty/pty-supervisor'
import {
  ECHO_REQUEST_TYPE,
  localPath,
  type Disposer,
  type EchoWorkerProtocol,
  type IpcEventChannel,
  type IpcEventPayload,
} from '../shared'

let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
let localHost: LocalHost | null = null
let ptySupervisor: PtySupervisor | null = null
let disposeWatch: Disposer | null = null

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

async function startup(): Promise<void> {
  echoWorker = createWorkerClient<EchoWorkerProtocol>(
    workerPath('echo-worker.js'),
    'hvir-echo',
  )
  localHost = new LocalHost()
  ptySupervisor = new PtySupervisor()
  await localHost.connect()

  const root = localPath(projectRootArgument())
  const emit = <E extends IpcEventChannel>(
    channel: E,
    payload: IpcEventPayload<E>,
  ): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  registerIpcHandlers({
    echoWorker,
    host: localHost,
    root,
    ptySupervisor,
    emit,
  })
  let pendingWatchEvent: IpcEventPayload<'project:watch'> | undefined
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  const stopHostWatch = localHost.watch(
    root,
    (event) => {
      pendingWatchEvent = event
      if (watchTimer) return
      // Watcher churn must not become thousands of renderer IPC paints. The
      // tree only needs an invalidation signal during this spike.
      watchTimer = setTimeout(() => {
        watchTimer = undefined
        if (pendingWatchEvent) emit('project:watch', pendingWatchEvent)
        pendingWatchEvent = undefined
      }, 100)
    },
    { recursive: true },
  )
  disposeWatch = () => {
    if (watchTimer) clearTimeout(watchTimer)
    return stopHostWatch()
  }
  createWindow()

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function projectRootArgument(): string {
  const fromFlag = process.argv.find((arg) => arg.startsWith('--project-root='))
  return (
    fromFlag?.slice('--project-root='.length) ||
    process.env.HVIR_PROJECT_ROOT ||
    process.cwd()
  )
}

/**
 * Headless self-check (HVIR_SMOKE=1): stands up the full process model without
 * a human — echo utility process, the typed IPC handlers, LocalHost.exec/stat,
 * and a real window whose renderer round-trips `app:info` back through main —
 * then exits. Run under a display (or `xvfb-run`) so the window can paint.
 */
async function runSmoke(): Promise<number> {
  const worker = createWorkerClient<EchoWorkerProtocol>(
    workerPath('echo-worker.js'),
    'hvir-echo-smoke',
  )
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  let smokeWindow: BrowserWindow | undefined
  try {
    const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
    if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
    if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
    console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)

    // Register the real IPC handlers so the renderer's app:info resolves — this
    // exercises the whole renderer→main→worker path, not just the seams alone.
    await host.connect()
    registerIpcHandlers({
      echoWorker: worker,
      host,
      root: localPath(process.cwd()),
      ptySupervisor: supervisor,
      emit: (channel, payload) => {
        if (smokeWindow && !smokeWindow.isDestroyed()) {
          smokeWindow.webContents.send(channel, payload)
        }
      },
    })
    const result = await host.exec('/bin/echo', ['hvir'])
    if (result.stdout.trim() !== 'hvir')
      throw new Error(`exec mismatch: ${result.stdout}`)
    console.log('[smoke] LocalHost.exec OK')
    // prove host-qualified read works too
    await host.stat(localPath(process.cwd()))
    console.log('[smoke] LocalHost.stat OK')

    const win = createWindow()
    smokeWindow = win
    await withTimeout(
      new Promise<void>((resolve) => win.once('ready-to-show', resolve)),
      'window never became ready',
    )
    console.log('[smoke] window ready-to-show OK')

    // Execute through the isolated renderer's real preload bridge. Waiting for
    // these results proves the IPC calls completed; ready-to-show alone only
    // proves paint, not the round-trip claimed by this smoke check.
    const rendererResult = (await withTimeout(
      win.webContents.executeJavaScript(`
        Promise.all([
          window.hvir.invoke('app:info', undefined),
          window.hvir.invoke('demo:echo', { text: 'renderer-ping' })
        ]).then(([info, echoed]) => ({ info, echoed }))
      `),
      'renderer IPC round-trip timed out',
    )) as {
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

    // Wait for the actual Phase 2 vertical slice: Ghostty WASM mounted, the
    // native node-pty process spawned, and the lazy tree populated.
    const terminalStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const poll = () => {
            const status = document.querySelector('.terminal-panel .panel-meta')?.textContent || '';
            if (status.startsWith('pid ')) return resolve(status);
            if (status && status !== 'Starting…') return reject(new Error(status));
            setTimeout(poll, 50);
          };
          poll();
        })
      `),
      'terminal pane did not start',
    )) as string
    console.log(`[smoke] ghostty-web + PTY OK (${terminalStatus})`)

    const viewerStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const poll = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.textContent?.trim() === 'AGENTS.md');
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('AGENTS.md missing from tree'));
              return setTimeout(poll, 50);
            }
            file.click();
            const waitForHighlight = () => {
              const meta = document.querySelector('.viewer-panel .panel-meta')?.textContent || '';
              if (document.querySelector('.cm-editor') && meta.includes('markdown')) return resolve(meta);
              if (Date.now() > deadline) return reject(new Error('viewer highlight timed out: ' + meta));
              setTimeout(waitForHighlight, 50);
            };
            waitForHighlight();
          };
          poll();
        })
      `),
      'tree/viewer/worker did not become ready',
    )) as string
    console.log(`[smoke] ProjectHost tree + CodeMirror/Shiki worker OK (${viewerStatus})`)
    win.destroy()

    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    supervisor.disposeAll()
    await host.dispose()
    worker.dispose()
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15000,
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

void app.whenReady().then(async () => {
  if (process.env['HVIR_SMOKE']) {
    const code = await runSmoke()
    app.exit(code)
    return
  }
  await startup()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeWatch?.()
  disposeWatch = null
  ptySupervisor?.disposeAll()
  ptySupervisor = null
  void localHost?.dispose()
  localHost = null
  echoWorker?.dispose()
})
