/**
 * Main process entry.
 *
 * Wires the process model: creates the window, registers the typed IPC
 * contract, and spawns the echo utility process. Phase 1 ships an empty window;
 * every later feature plugs into the seams instantiated here.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { dispatchWorkerHostCall } from './git/worker-host-broker'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import { LocalHost, type ProjectHost } from './project-host'
import { ProjectRegistry, RendererSshPrompter } from './project-registry'
import { PtySupervisor } from './pty/pty-supervisor'
import { isSafeExternalUrl, isWorkbenchDocument } from './navigation-policy'
import {
  ECHO_REQUEST_TYPE,
  hostPath,
  joinHostPath,
  localPath,
  LOCAL_HOST_ID,
  type Disposer,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  HTML_PREVIEW_SCHEME,
} from '../shared'

protocol.registerSchemesAsPrivileged([
  {
    scheme: HTML_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, bypassCSP: false },
  },
])

const htmlPreviews = new HtmlPreviewProtocol()

let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
let gitWorker: WorkerClient<GitWorkerProtocol> | null = null
let projectRegistry: ProjectRegistry | null = null
let sshPrompter: RendererSshPrompter | null = null
let ptySupervisor: PtySupervisor | null = null
let disposeWatch: Disposer | null = null
let sessionOperation: Promise<void> = Promise.resolve()
let suspendSessions: Promise<void> = Promise.resolve()
let shutdownStarted = false
let shutdownComplete = false

function createWindow(
  discardRendererResources: (ownerId: number) => void = (ownerId) => {
    ptySupervisor?.disposeOwner(ownerId)
    sshPrompter?.cancelAll()
    htmlPreviews.clear()
  },
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // electron-vite sets ELECTRON_RENDERER_URL in dev (Vite dev server); in a
  // packaged build we load the built HTML from disk.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const packagedEntry = join(__dirname, '../renderer/index.html')
  const entryUrl = rendererUrl ?? pathToFileURL(packagedEntry).href
  const ownerId = win.webContents.id

  win.on('ready-to-show', () => win.show())
  // Phase 2 has one renderer-owned terminal set. A renderer reload/crash cannot
  // run React cleanup, so main must end those PTYs rather than orphan shells.
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && isWorkbenchDocument(url, entryUrl)) {
      discardRendererResources(ownerId)
    }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isWorkbenchDocument(url, entryUrl)) return
    event.preventDefault()
    console.warn(`[navigation] blocked workbench replacement: ${url}`)
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) {
      console.error(
        `[window] main document failed to load (${code}): ${description} ${url}`,
      )
    }
  })
  let rendererRecoveryRequested = false
  win.webContents.on('render-process-gone', (_event, details) => {
    discardRendererResources(ownerId)
    console.error(`[window] renderer process gone: ${JSON.stringify(details)}`)
    if (rendererRecoveryRequested) {
      rendererRecoveryRequested = false
    } else if (!win.isDestroyed() && details.reason !== 'clean-exit') {
      // A crashed renderer cannot paint a React recovery screen. Reloading
      // creates a fresh renderer process and restores persisted tabs.
      win.webContents.reload()
    }
  })
  let handlingUnresponsive = false
  win.webContents.on('unresponsive', () => {
    if (handlingUnresponsive || win.isDestroyed()) return
    handlingUnresponsive = true
    console.error('[window] renderer became unresponsive')
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'hvir is not responding',
        message: 'The hvir window stopped responding.',
        detail: 'Reloading will recover the window but may discard unsaved source edits.',
        buttons: ['Wait', 'Reload hvir'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1 && !win.isDestroyed()) {
          rendererRecoveryRequested = true
          win.webContents.forcefullyCrashRenderer()
          win.webContents.reload()
        }
      })
      .finally(() => {
        handlingUnresponsive = false
      })
  })
  win.on('closed', () => {
    discardRendererResources(ownerId)
    if (
      process.platform === 'darwin' &&
      BrowserWindow.getAllWindows().length === 0 &&
      !shutdownStarted
    ) {
      suspendSessions = suspendWorkbenchSessions().catch((error) =>
        console.error('[session] cleanup after window close failed', error),
      )
    }
  })

  // Open external links in the OS browser, never in-app (security posture).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) {
    void win
      .loadURL(rendererUrl)
      .catch((error) => console.error('[window] failed to load renderer URL', error))
  } else {
    void win
      .loadFile(packagedEntry)
      .catch((error) => console.error('[window] failed to load renderer file', error))
  }

  return win
}

async function startup(): Promise<void> {
  const emit = <E extends IpcEventChannel>(
    channel: E,
    payload: IpcEventPayload<E>,
  ): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }
  sshPrompter = new RendererSshPrompter(
    (prompt) => emit('ssh:prompt', prompt),
    (hostId) => emit('ssh:prompt-cancel', { hostId }),
  )
  projectRegistry = await ProjectRegistry.create(
    localPath(projectRootArgument()),
    sshPrompter,
    join(app.getPath('userData'), 'known-hosts.json'),
    (state) => emit('project:state', state),
  )
  echoWorker = createWorkerClient<EchoWorkerProtocol>(
    workerPath('echo-worker.js'),
    'hvir-echo',
  )
  gitWorker = createWorkerClient<GitWorkerProtocol>(
    workerPath('git-worker.js'),
    'hvir-git',
    (call) => dispatchWorkerHostCall(call, projectRegistry?.active ?? null),
  )
  ptySupervisor = new PtySupervisor()

  registerIpcHandlers({
    echoWorker,
    gitWorker,
    getProject: () => {
      if (!projectRegistry) throw new Error('Project registry is unavailable')
      return projectRegistry.active
    },
    listHosts: () => projectRegistry?.listHosts() ?? [],
    connectHost: (hostId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const connected = await projectRegistry.connectHost(hostId)
        if (projectRegistry.active.host.hostId === hostId) {
          await stopProjectWatch()
          startProjectWatch(projectRegistry.active, emit)
        }
        return connected
      }),
    disconnectHost: (hostId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        if (projectRegistry.active.host.hostId === hostId) {
          await stopProjectWatch()
          ptySupervisor?.disposeAll()
          htmlPreviews.clear()
        }
        return projectRegistry.disconnectHost(hostId)
      }),
    browseHost: async (hostId, path) => {
      if (!projectRegistry) throw new Error('Project registry is unavailable')
      return projectRegistry.browseHost(hostId, path)
    },
    openProject: (hostId, path) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const previousHostId = projectRegistry.active.host.hostId
        const state = await projectRegistry.open(hostId, path)
        await stopProjectWatch()
        ptySupervisor?.disposeAll()
        htmlPreviews.clear()
        if (previousHostId !== hostId && previousHostId !== LOCAL_HOST_ID) {
          await projectRegistry.disconnectHost(previousHostId)
        }
        startProjectWatch(projectRegistry.active, emit)
        return state
      }),
    respondSshPrompt: (id, answers) => sshPrompter?.respond(id, answers),
    ptySupervisor,
    htmlPreviews,
    emit,
  })
  startProjectWatch(projectRegistry.active, emit)
  createWindow()

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopen = (): void => {
        if (!projectRegistry || BrowserWindow.getAllWindows().length > 0) return
        if (projectRegistry.active.host.connectionState === 'connected') {
          startProjectWatch(projectRegistry.active, emit)
        }
        createWindow()
      }
      void suspendSessions.then(reopen, (error) => {
        console.error('[session] cleanup before reopen failed', error)
        reopen()
      })
    }
  })
}

async function stopProjectWatch(): Promise<void> {
  const stop = disposeWatch
  disposeWatch = null
  await stop?.()
}

function startProjectWatch(
  project: { readonly host: ProjectHost; readonly root: HostPath },
  emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void,
): void {
  const pendingWatchEvents = new Map<string, IpcEventPayload<'project:watch'>>()
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stops: Disposer[] = []
  const receive = (event: IpcEventPayload<'project:watch'>): void => {
    if (stopped) return
    pendingWatchEvents.set(`${event.path.hostId}:${event.path.path}`, event)
    if (watchTimer) return
    // Watcher churn must not become thousands of renderer IPC paints. The
    // tree only needs an invalidation signal during this spike.
    watchTimer = setTimeout(() => {
      watchTimer = undefined
      for (const pending of pendingWatchEvents.values()) {
        emit('project:watch', pending)
      }
      pendingWatchEvents.clear()
    }, 100)
  }
  stops.push(
    project.host.watch(project.root, receive, {
      recursive: true,
      excludeDirectoryNames: ['.git', 'node_modules', 'out', 'dist'],
      onError: (error) => console.error('[watch] project watcher failed', error),
    }),
  )
  // Root watches deliberately prune `.git`, whose object database is noisy.
  // Watch only the repository metadata directory at depth zero so terminal
  // commit/add/checkout operations refresh Changes and History immediately.
  void project.host
    .exec('git', ['-C', project.root.path, 'rev-parse', '--absolute-git-dir'])
    .then((result) => {
      const gitDirectory = result.code === 0 ? result.stdout.trim() : ''
      if (stopped || !gitDirectory.startsWith('/')) return
      stops.push(
        project.host.watch(hostPath(project.root.hostId, gitDirectory), receive, {
          recursive: false,
          onError: (error) => console.error('[watch] git metadata watcher failed', error),
        }),
      )
    })
    .catch((error) => console.error('[watch] git metadata discovery failed', error))
  disposeWatch = async () => {
    stopped = true
    if (watchTimer) clearTimeout(watchTimer)
    await Promise.all(stops.map(async (stop) => stop()))
  }
}

function serializeSession<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionOperation.then(operation, operation)
  sessionOperation = result.then(
    () => undefined,
    () => undefined,
  )
  return result
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
  const git = createWorkerClient<GitWorkerProtocol>(
    workerPath('git-worker.js'),
    'hvir-git-smoke',
    (call) => dispatchWorkerHostCall(call, { host, root: localPath(process.cwd()) }),
  )
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  let smokeWindow: BrowserWindow | undefined
  let stopSmokeWatch: Disposer | undefined
  const smokeRoot = localPath(process.cwd())
  const liveReloadPath = joinHostPath(smokeRoot, '.hvir-smoke-live.txt')
  const largeJsonPath = joinHostPath(smokeRoot, '.hvir-smoke-large.json')
  try {
    const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
    if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
    if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
    console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)

    // Register the real IPC handlers so the renderer's app:info resolves — this
    // exercises the whole renderer→main→worker path, not just the seams alone.
    await host.connect()
    const liveReloadBefore = `${Array.from({ length: 240 }, (_, index) => `line ${index}`).join('\n')}\n`
    await host.writeFile(liveReloadPath, liveReloadBefore)
    await host.writeFile(
      largeJsonPath,
      JSON.stringify(
        Array.from({ length: 50_000 }, (_, index) => ({
          id: index,
          value: `item-${index}`,
        })),
      ),
    )
    const emit: EmitSmokeEvent = (channel, payload) => {
      if (smokeWindow && !smokeWindow.isDestroyed()) {
        smokeWindow.webContents.send(channel, payload)
      }
    }
    registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      getProject: () => ({ host, root: smokeRoot }),
      listHosts: () => [
        {
          hostId: host.hostId,
          label: 'Local',
          kind: 'local',
          connectionState: host.connectionState,
          watchTier: host.watchTier,
        },
      ],
      connectHost: () =>
        Promise.resolve({
          host: {
            hostId: host.hostId,
            label: 'Local',
            kind: 'local',
            connectionState: host.connectionState,
            watchTier: host.watchTier,
          },
          suggestedPath: smokeRoot.path,
        }),
      disconnectHost: () =>
        Promise.resolve({
          hostId: host.hostId,
          label: 'Local',
          kind: 'local',
          connectionState: host.connectionState,
          watchTier: host.watchTier,
        }),
      browseHost: async (_hostId, path) => {
        if (path.endsWith('.missing')) throw new Error(`Folder not found: ${path}`)
        const canonical = await host.realpath(localPath(path))
        const directories = (await host.readdir(canonical)).filter(
          (entry) => entry.type === 'dir',
        )
        return { path: canonical, directories }
      },
      openProject: () =>
        Promise.resolve({
          root: smokeRoot,
          connectionState: host.connectionState,
          watchTier: host.watchTier,
        }),
      respondSshPrompt: () => undefined,
      ptySupervisor: supervisor,
      htmlPreviews,
      emit,
    })
    stopSmokeWatch = host.watch(smokeRoot, (event) => emit('project:watch', event), {
      recursive: true,
      excludeDirectoryNames: ['.git', 'node_modules', 'out', 'dist'],
    })
    const result = await host.exec('/bin/echo', ['hvir'])
    if (result.stdout.trim() !== 'hvir')
      throw new Error(`exec mismatch: ${result.stdout}`)
    console.log('[smoke] LocalHost.exec OK')
    // prove host-qualified read works too
    await host.stat(localPath(process.cwd()))
    console.log('[smoke] LocalHost.stat OK')

    const win = createWindow((ownerId) => {
      supervisor.disposeOwner(ownerId)
      htmlPreviews.clear()
    })
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

    const containedSessionError = (await win.webContents.executeJavaScript(`
      window.hvir.invoke('project:browse-host', {
        hostId: 'local',
        path: '/tmp/hvir-smoke.missing'
      }).then((result) => !result.ok && result.error)
    `)) as string
    if (!containedSessionError.includes('Folder not found')) {
      throw new Error(
        `session error escaped its result envelope: ${containedSessionError}`,
      )
    }
    console.log('[smoke] expected session errors stay contained')

    emit('ssh:prompt', {
      id: 9001,
      hostId: 'smoke-host',
      kind: 'host-key',
      title: 'Trust smoke-host?',
      instructions: 'Verify the SHA-256 fingerprint before trusting this host.',
      fingerprint: `SHA256:${'abcdefghijklmnopqrstuvwxyz'.repeat(4)}`,
      prompts: [],
    })
    const hostKeyPromptStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const dialog = document.querySelector('.project-dialog');
            const fingerprint = document.querySelector('.ssh-host-fingerprint');
            const trust = [...document.querySelectorAll('.project-dialog button')]
              .find((node) => node.textContent?.trim() === 'Trust Host');
            if (dialog && fingerprint && trust) {
              const fits = dialog.scrollWidth <= dialog.clientWidth;
              trust.click();
              return fits
                ? resolve('wrapped fingerprint · explicit trust')
                : reject(new Error('host fingerprint overflowed its dialog'));
            }
            if (Date.now() > deadline) return reject(new Error('host-key prompt missing'));
            setTimeout(poll, 25);
          };
          poll();
        })
      `),
      'host-key prompt timed out',
    )) as string
    console.log(`[smoke] SSH host-key prompt OK (${hostKeyPromptStatus})`)

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

    const reconnectTerminalStatus = await withTimeout(
      (async () => {
        const firstTerminal = supervisor.list()[0]
        if (!firstTerminal)
          throw new Error('initial terminal disappeared before reconnect')
        let terminalProbe = ''
        const detachProbe = supervisor.attach(firstTerminal.id, firstTerminal.ownerId, {
          onData: (data) => {
            terminalProbe = (terminalProbe + data).slice(-4_096)
          },
        })
        supervisor.write(
          firstTerminal.id,
          firstTerminal.ownerId,
          "printf '\\033[41m\\033[2J\\033[H\\033[0m'; sleep 1\n",
        )
        try {
          await win.webContents.executeJavaScript(`
            new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
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
                const rect = canvas.getBoundingClientRect();
                lastState = 'canvas=' + canvas.width + 'x' + canvas.height +
                  ' rect=' + rect.width + 'x' + rect.height +
                  ' visibility=' + getComputedStyle(surface).visibility +
                  ' pixel=' + [...pixel].join(',');
                if (pixel[0] > 120 && pixel[1] < 140) return resolve(true);
              }
              if (Date.now() > deadline) return reject(new Error(
                'terminal fixture did not paint: ' + lastState
              ));
              setTimeout(poll, 25);
            };
            poll();
            })
          `)
        } catch (error) {
          console.error(`[smoke] PTY probe: ${JSON.stringify(terminalProbe)}`)
          throw error
        } finally {
          void detachProbe()
        }
        await win.webContents.executeJavaScript(`
          window.__hvirSmokeTerminalCanvas = document.querySelector('.terminal-container canvas');
          window.__hvirSmokeTerminalHost = document.querySelector('.terminal-container');
        `)
        emit('project:state', {
          root: smokeRoot,
          connectionState: 'disconnected',
          watchTier: 'native',
        })
        await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const poll = () => {
              const container = document.querySelector('.terminal-container');
              const status = document.querySelector('.terminal-panel .panel-meta')?.textContent || '';
              if (container?.childElementCount === 0 && status === 'disconnected') return resolve(true);
              if (Date.now() > deadline) return reject(new Error('terminal did not clear on disconnect'));
              setTimeout(poll, 25);
            };
            poll();
          })
        `)
        emit('project:state', {
          root: smokeRoot,
          connectionState: 'connected',
          watchTier: 'native',
        })
        const status: unknown = await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            let lastState = 'not mounted';
            const poll = () => {
              const canvas = document.querySelector('.terminal-container canvas');
              const host = document.querySelector('.terminal-container');
              const status = document.querySelector('.terminal-panel .panel-meta')?.textContent || '';
              if (
                canvas &&
                host &&
                canvas !== window.__hvirSmokeTerminalCanvas &&
                host !== window.__hvirSmokeTerminalHost &&
                !window.__hvirSmokeTerminalHost?.isConnected &&
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
                  ' hostChanged=' + (host !== window.__hvirSmokeTerminalHost) +
                  ' oldDetached=' + (!window.__hvirSmokeTerminalHost?.isConnected) +
                  ' pixel=' + (pixel ? [...pixel].join(',') : 'missing');
                if (pixel && pixel[0] < 50 && pixel[1] < 50 && pixel[2] < 60) {
                  return resolve(status);
                }
              }
              if (Date.now() > deadline) {
                return reject(new Error('terminal did not remount cleanly: ' + lastState));
              }
              setTimeout(poll, 25);
            };
            poll();
          })
        `)
        if (typeof status !== 'string')
          throw new Error('terminal reconnect returned no status')
        return status
      })(),
      'terminal reconnect lifecycle timed out',
    )
    console.log(`[smoke] terminal reconnect remount OK (${reconnectTerminalStatus})`)

    const multiTerminalStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 8000;
          document.querySelector('.terminal-icon-button')?.click();
          const waitForSecond = () => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const surfaces = [...document.querySelectorAll('.terminal-surface')];
            const active = document.querySelector('.terminal-surface.active');
            const status = active?.querySelector('.panel-meta')?.textContent || '';
            if (rows.length === 2 && surfaces.length === 2 && status.startsWith('pid ')) {
              const visible = surfaces.filter(
                (surface) => getComputedStyle(surface).visibility === 'visible'
              );
              if (visible.length !== 1 || visible[0] !== active) {
                return reject(new Error('terminal selection did not isolate one canvas'));
              }
              rows[0]?.querySelector('.terminal-list-main')?.click();
              const waitForSwitch = () => {
                if (document.querySelector('.terminal-list-row.active') === rows[0]) {
                  return resolve('2 live canvases · switch');
                }
                if (Date.now() > deadline) {
                  return reject(new Error('terminal selection did not switch'));
                }
                setTimeout(waitForSwitch, 25);
              };
              return waitForSwitch();
            }
            if (Date.now() > deadline) return reject(new Error(
              'second terminal did not start: rows=' + rows.length +
              ' surfaces=' + surfaces.length + ' status=' + status
            ));
            setTimeout(waitForSecond, 25);
          };
          const waitForMenu = () => {
            const shell = [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.textContent?.trim() === 'Shell');
            if (shell) {
              shell.click();
              return waitForSecond();
            }
            if (Date.now() > deadline) return reject(new Error('new-terminal menu did not open'));
            setTimeout(waitForMenu, 25);
          };
          waitForMenu();
        })
      `),
      'multi-terminal interaction timed out',
      10_000,
    )) as string
    const secondTerminal = supervisor.list()[1]
    if (!secondTerminal) throw new Error('second terminal was not registered')
    supervisor.write(
      secondTerminal.id,
      secondTerminal.ownerId,
      "printf '\\033]0;Smoke agent\\007\\007'\n",
    )
    const terminalSignalStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const title = rows[1]?.querySelector('.terminal-list-title')?.textContent || '';
            const bell = rows[1]?.querySelector('.terminal-attention.bell');
            if (title === 'Smoke agent' && bell) {
              rows[1]?.querySelector('.terminal-close-button')?.click();
              return resolve('live title · bell dot · close');
            }
            if (Date.now() > deadline) return reject(new Error(
              'terminal signal missing: title=' + title + ' bell=' + Boolean(bell)
            ));
            setTimeout(poll, 25);
          };
          poll();
        })
      `),
      'terminal signal interaction timed out',
    )) as string
    console.log(
      `[smoke] multi-terminal rail OK (${multiTerminalStatus} · ${terminalSignalStatus})`,
    )

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
            const waitForRender = () => {
              const rendered = document.querySelector('.markdown-body');
              const activeMode = document.querySelector('.mode-control button.active')?.textContent || '';
              if (activeMode.trim() !== 'rendered') {
                const renderedMode = [...document.querySelectorAll('.mode-control button')]
                  .find((node) => node.textContent?.trim() === 'rendered');
                renderedMode?.click();
              }
              if (rendered && activeMode.trim() === 'rendered') {
                const source = [...document.querySelectorAll('.mode-control button')]
                  .find((node) => node.textContent?.trim() === 'source');
                if (!source) return reject(new Error('source mode control missing'));
                source.click();
                const waitForSource = () => {
                  const status = document.querySelector('.source-meta')?.textContent || '';
                  if (document.querySelector('.cm-editor') && status.includes('markdown')) {
                    return resolve('rendered→source · ' + status);
                  }
                  if (Date.now() > deadline) return reject(new Error('source highlight timed out: ' + status));
                  setTimeout(waitForSource, 50);
                };
                waitForSource();
                return;
              }
              if (Date.now() > deadline) return reject(new Error('markdown render timed out'));
              setTimeout(waitForRender, 50);
            };
            waitForRender();
          };
          poll();
        })
      `),
      'tree/viewer/worker did not become ready',
    )) as string
    console.log(`[smoke] ProjectHost tree + CodeMirror/Shiki worker OK (${viewerStatus})`)

    const renderedFixture = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              const closedDirectory = node.classList.contains('directory-row') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '›';
              if (!node.classList.contains('directory-row') || closedDirectory) node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('tree path missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test', () =>
            openWhenReady('/test/fixtures', () =>
              openWhenReady('/test/fixtures/rendered.md', () => {
                const waitForRendered = () => {
                  const tasks = document.querySelectorAll('.task-list-item-checkbox');
                  const image = document.querySelector('img[alt="Repository image fixture"]');
                  if (document.querySelector('.mermaid-diagram svg') &&
                      document.querySelector('.markdown-body .shiki') &&
                      image?.getAttribute('src')?.startsWith('blob:') &&
                      image.complete && image.naturalWidth > 0 &&
                      tasks.length === 4 &&
                      document.querySelectorAll('.task-list-item-checkbox:checked').length === 1) {
                    if (document.querySelectorAll('.task-list-item-checkbox.inapplicable').length !== 1) {
                      return reject(new Error('GitLab inapplicable task did not render'));
                    }
                    const body = document.querySelector('.markdown-body');
                    body?.dispatchEvent(new Event('scroll', { bubbles: true }));
                    return setTimeout(() => {
                      if (document.querySelector('.mermaid-diagram svg')) {
                        resolve('Shiki + Mermaid + ProjectHost image + task lists + stable scroll');
                      } else {
                        reject(new Error('scroll destroyed Mermaid diagram'));
                      }
                    }, 100);
                  }
                  if (Date.now() > deadline) return reject(new Error('rendered fixture timed out'));
                  setTimeout(waitForRendered, 50);
                };
                waitForRendered();
              })
            )
          );
        })
      `),
      'Markdown Mermaid fixture did not render',
      20000,
    )) as string
    console.log(`[smoke] rendered Markdown fixture OK (${renderedFixture})`)

    const renderedLinkStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const link = (text) => [...document.querySelectorAll('.markdown-body a')]
            .find((node) => node.textContent?.trim() === text);
          const missing = link('Missing target');
          if (!missing) return reject(new Error('rendered missing-link fixture absent'));
          missing.click();
          const waitForYaml = () => {
            const title = document.querySelector('.viewer-title')?.textContent || '';
            const keys = [...document.querySelectorAll('.json-key')]
              .map((node) => node.textContent || '');
            const fixturesOpen = [...document.querySelectorAll('.directory-row')]
              .some((node) => node.getAttribute('title')?.endsWith('/test/fixtures') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '⌄');
            if (title.includes('rendered.yml') && keys.some((key) => key.includes('name')) && fixturesOpen) {
              return resolve('internal tab · YAML tree · tree preserved · ' + location.protocol);
            }
            if (Date.now() > deadline) return reject(new Error(
              'internal YAML link timed out: ' + title + ' ' + keys.join(',')
            ));
            setTimeout(waitForYaml, 50);
          };
          const waitForContainedError = () => {
            if (document.querySelector('.viewer-empty.error')) {
              const renderedTab = [...document.querySelectorAll('.viewer-tab')]
                .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
              renderedTab?.querySelector('.tab-main')?.click();
              const waitForOriginal = () => {
                const yaml = link('Open the YAML fixture');
                if (yaml) {
                  yaml.click();
                  return waitForYaml();
                }
                if (Date.now() > deadline) return reject(new Error('original rendered tab did not recover'));
                setTimeout(waitForOriginal, 50);
              };
              return waitForOriginal();
            }
            if (Date.now() > deadline) return reject(new Error('missing internal link escaped the viewer'));
            setTimeout(waitForContainedError, 50);
          };
          waitForContainedError();
        })
      `),
      'rendered internal link did not stay in hvir',
    )) as string
    console.log(`[smoke] rendered link routing + YAML OK (${renderedLinkStatus})`)

    const sandboxPolicy = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              const closedDirectory = node.classList.contains('directory-row') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '›';
              if (!node.classList.contains('directory-row') || closedDirectory) node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('tree path missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test', () =>
            openWhenReady('/test/fixtures', () =>
              openWhenReady('/test/fixtures/html-sandbox-attack.html', () => {
                const waitForFrame = () => {
                  const frame = document.querySelector('.html-preview');
                  if (frame) return resolve(frame.getAttribute('sandbox') || '');
                  if (Date.now() > deadline) return reject(new Error('HTML iframe missing'));
                  setTimeout(waitForFrame, 50);
                };
                waitForFrame();
              })
            )
          );
        })
      `),
      'HTML sandbox preview did not open',
    )) as string
    if (sandboxPolicy !== 'allow-scripts') {
      throw new Error(`unsafe HTML sandbox policy: ${sandboxPolicy}`)
    }
    const iframe = await withTimeout(
      (async () => {
        for (;;) {
          const frame = win.webContents.mainFrame.frames.find((candidate) =>
            candidate.url.startsWith(`${HTML_PREVIEW_SCHEME}://document/`),
          )
          if (frame) return frame
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      })(),
      'sandboxed HTML frame was not created',
    )
    const sandboxProbe = await withTimeout(
      (async (): Promise<{
        ran?: string
        node?: string
        navigation?: string
        popup?: string
        preHead?: string
      }> => {
        for (;;) {
          const probe = (await iframe.executeJavaScript(`({
            ran: document.body?.dataset.ran,
            node: document.body?.dataset.node,
            navigation: document.body?.dataset.navigation,
            popup: document.body?.dataset.popup,
            preHead: globalThis.preHeadRan
          })`)) as {
            ran?: string
            node?: string
            navigation?: string
            popup?: string
            preHead?: string
          }
          if (probe.ran) return probe
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
      })(),
      'HTML sandbox probe script did not run',
    )
    if (
      iframe.origin !== 'null' ||
      sandboxProbe.ran !== 'yes' ||
      sandboxProbe.node !== 'blocked' ||
      sandboxProbe.navigation !== 'blocked' ||
      sandboxProbe.popup !== 'blocked' ||
      sandboxProbe.preHead !== 'yes'
    ) {
      throw new Error(
        `HTML sandbox escape probe failed (${iframe.origin} ${JSON.stringify(sandboxProbe)})`,
      )
    }
    console.log('[smoke] sandboxed HTML blocked node, navigation, and popups')

    const modeBinding = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const activeMode = () => document.querySelector('.mode-control button.active')?.textContent?.trim();
        const before = activeMode();
        const terminal = document.querySelector('.terminal-panel');
        terminal?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'M', ctrlKey: true, shiftKey: true, bubbles: true
        }));
        if (activeMode() !== before) return reject(new Error('terminal chord changed viewer mode'));
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'M', ctrlKey: true, shiftKey: true, bubbles: true
        }));
        requestAnimationFrame(() => {
          const after = activeMode();
          if (!after || after === before) return reject(new Error('mode chord did not cycle'));
          const rendered = [...document.querySelectorAll('.mode-control button')]
            .find((node) => node.textContent?.trim() === 'rendered');
          rendered?.click();
          resolve(before + '→' + after);
        });
      })
    `)) as string
    console.log(`[smoke] mode keybinding avoids terminal paste (${modeBinding})`)

    const jsonStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const open = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.textContent?.trim() === '.hvir-smoke-large.json');
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('large JSON fixture missing'));
              return setTimeout(open, 50);
            }
            file.click();
            const waitForTree = () => {
              const summary = document.querySelector('.json-tree summary')?.textContent || '';
              const renderedNodes = document.querySelectorAll('.json-tree details').length;
              if (summary.includes('[50000]') && renderedNodes > 1) {
                if (renderedNodes > 205) return reject(new Error('JSON tree rendered eagerly: ' + renderedNodes));
                return resolve(renderedNodes + ' nodes for 50000 entries');
              }
              if (Date.now() > deadline) return reject(new Error('worker JSON tree timed out: ' + summary));
              setTimeout(waitForTree, 50);
            };
            waitForTree();
          };
          open();
        })
      `),
      'large JSON did not render lazily',
      20000,
    )) as string
    console.log(`[smoke] worker-backed lazy JSON OK (${jsonStatus})`)

    const scrollBefore = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const open = () => {
            const staleTab = [...document.querySelectorAll('.viewer-tab')]
              .find((node) =>
                node.querySelector('.tab-main')?.getAttribute('title') ===
                  ${JSON.stringify(liveReloadPath.path)} &&
                node.querySelector('.tab-status')?.textContent?.includes('●')
              );
            if (staleTab) {
              const confirm = window.confirm;
              window.confirm = () => true;
              staleTab.querySelector('.tab-close')?.click();
              window.confirm = confirm;
              return setTimeout(open, 50);
            }
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.textContent?.trim() === '.hvir-smoke-live.txt');
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('live-reload fixture missing'));
              return setTimeout(open, 50);
            }
            file.click();
            const waitForSource = () => {
              const scroller = document.querySelector('.cm-scroller');
              if (scroller) {
                scroller.scrollTop = 220;
                return requestAnimationFrame(() => resolve(scroller.scrollTop));
              }
              if (Date.now() > deadline) return reject(new Error('live-reload source missing'));
              setTimeout(waitForSource, 50);
            };
            waitForSource();
          };
          open();
        })
      `),
      'live-reload fixture did not open',
    )) as number
    await host.writeFile(
      liveReloadPath,
      liveReloadBefore.replace('line 20\n', 'line 20 external marker\n'),
    )
    const scrollAfter = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const poll = () => {
            const content = document.querySelector('.cm-content')?.textContent || '';
            const scroller = document.querySelector('.cm-scroller');
            if (content.includes('external marker') && scroller) return resolve(scroller.scrollTop);
            if (Date.now() > deadline) return reject(new Error('external update did not reload'));
            setTimeout(poll, 50);
          };
          poll();
        })
      `),
      'open file did not live-reload',
    )) as number
    if (Math.abs(scrollAfter - scrollBefore) > 2) {
      throw new Error(`live reload jumped scroll (${scrollBefore}→${scrollAfter})`)
    }
    console.log(`[smoke] clean tab live-reload preserved scroll (${scrollAfter}px)`)

    await win.webContents.executeJavaScript(`
      document.querySelector('.cm-content')?.focus();
    `)
    await win.webContents.insertText('saved marker\n')
    await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            if (document.querySelector('.viewer-tab.active .tab-status')?.textContent?.includes('●')) {
              return resolve(true);
            }
            if (Date.now() > deadline) return reject(new Error('source edit did not mark tab dirty'));
            setTimeout(poll, 25);
          };
          poll();
        })
      `),
      'source edit did not reach tab state',
    )
    const saveModifier = process.platform === 'darwin' ? 'meta' : 'control'
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'S',
      modifiers: [saveModifier],
    })
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'S',
      modifiers: [saveModifier],
    })
    await withTimeout(
      (async (): Promise<void> => {
        for (;;) {
          if ((await host.readTextFile(liveReloadPath)).includes('saved marker')) return
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      })(),
      'Ctrl+S did not write the edited source through ProjectHost',
    )
    console.log('[smoke] source edit + Ctrl+S save OK')

    const diffBases = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const waitFor = (test, message) => new Promise((done, fail) => {
            const poll = () => {
              const value = test();
              if (value) return done(value);
              if (Date.now() > deadline) return fail(new Error(message));
              setTimeout(poll, 50);
            };
            poll();
          });
          (async () => {
            const file = await waitFor(
              () => [...document.querySelectorAll('.file-row')]
                .find((node) => node.textContent?.trim() === 'package.json'),
              'package.json missing'
            );
            file.click();
            await waitFor(
              () => document.querySelector('.viewer-title')?.textContent?.includes('package.json'),
              'package.json did not become active'
            );
            const diffButton = await waitFor(
              () => [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.textContent?.trim() === 'diff'),
              'diff mode button missing'
            );
            diffButton.click();
            const expectations = [
              ['head', 'HEAD'],
              ['branch-point', 'Branch point'],
              ['working-tree', 'Index']
            ];
            for (const [base, label] of expectations) {
              const select = await waitFor(
                () => document.querySelector('.diff-base-select'),
                'diff base selector missing'
              );
              select.value = base;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              await waitFor(
                () => document.querySelector('.cm-mergeView') &&
                  document.querySelector('.diff-labels')?.textContent?.includes(label),
                'diff did not render base ' + base
              );
            }
            resolve(expectations.map(([base]) => base).join(', '));
          })().catch(reject);
        })
      `),
      'single-file git diff modes did not render',
      20000,
    )) as string
    console.log(`[smoke] CodeMirror git diff bases OK (${diffBases})`)

    const gitPanelStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const button = (text) => [...document.querySelectorAll('button')]
            .find((node) => node.textContent?.trim().startsWith(text));
          button('Git')?.click();
          const waitForChanges = () => {
            const changed = document.querySelector('.git-file');
            if (!changed) {
              if (Date.now() > deadline) return reject(new Error('Git changes did not load'));
              return setTimeout(waitForChanges, 50);
            }
            const untracked = changed.querySelector('small')?.textContent?.trim().startsWith('?');
            changed.click();
            const waitForView = () => {
              const activeMode = [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.getAttribute('aria-pressed') === 'true')
                ?.textContent?.trim();
              if (!activeMode) {
                if (Date.now() > deadline) return reject(new Error('Git file did not open'));
                return setTimeout(waitForView, 50);
              }
              if (untracked ? activeMode === 'diff' : activeMode !== 'diff') {
                return reject(new Error(
                  'Git file opened in unexpected mode: ' + activeMode +
                    (untracked ? ' for untracked file' : ' for tracked file')
                ));
              }
              button('History')?.click();
              const waitForHistory = () => {
                const commit = document.querySelector('.git-rail-commit');
                if (!commit) {
                  if (Date.now() > deadline) return reject(new Error('Git history did not page'));
                  return setTimeout(waitForHistory, 50);
                }
                commit.click();
                const waitForRailDetail = () => {
                  const openFull = commit.closest('.git-rail-history-row')
                    ?.querySelector('.git-rail-open-full');
                  if (
                    document.querySelector('.git-rail-history-summary') &&
                    document.querySelector('.git-rail-history-tree.file') &&
                    openFull
                  ) {
                    openFull.click();
                    return waitForDetail();
                  }
                  if (Date.now() > deadline) {
                    return reject(new Error('Commit did not expand in rail history'));
                  }
                  setTimeout(waitForRailDetail, 50);
                };
                const waitForDetail = () => {
                  if (
                    document.querySelector('.git-graph-row.active') &&
                    document.querySelector('.git-commit-inspector') &&
                    document.querySelector('.git-commit-tree-row.file')
                  ) {
                    if (document.querySelectorAll('.viewer-tab.active').length !== 1) {
                      return reject(new Error('Graph activation left two active tabs'));
                    }
                    return resolve(
                      'changes→' + activeMode +
                        ' · paged history→rail tree→graph detail'
                    );
                  }
                  if (Date.now() > deadline) return reject(new Error('Commit graph detail did not load'));
                  setTimeout(waitForDetail, 50);
                };
                waitForRailDetail();
              };
              waitForHistory();
            };
            waitForView();
          };
          waitForChanges();
        })
      `),
      'Git panel integration timed out',
      20000,
    )) as string
    console.log(`[smoke] mounted Git panel OK (${gitPanelStatus})`)

    const blameStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const button = (text) => [...document.querySelectorAll('button')]
            .find((node) => node.textContent?.trim() === text);
          button('Files')?.click();
          const waitForSource = () => {
            const blameButton = document.querySelector('.blame-toggle');
            if (!blameButton || !document.querySelector('.source-shell .cm-editor')) {
              if (Date.now() > deadline) return reject(new Error('source view missing for blame'));
              return setTimeout(waitForSource, 50);
            }
            blameButton.click();
            const waitForBlame = () => {
              const marker = document.querySelector('.cm-blame-marker');
              if (marker) {
                const label = marker.textContent || 'blame marker';
                blameButton.click();
                return requestAnimationFrame(() => {
                  document.querySelector('.cm-blame-gutter')
                    ? reject(new Error('disabled blame gutter still reserves width'))
                    : resolve(label + ' · compact when off');
                });
              }
              const status = document.querySelector('.source-meta')?.textContent || '';
              if (status.includes('blame unavailable')) return reject(new Error(status));
              if (Date.now() > deadline) return reject(new Error('blame gutter did not load: ' + status));
              setTimeout(waitForBlame, 50);
            };
            waitForBlame();
          };
          const openTracked = () => {
            const tracked = [...document.querySelectorAll('.file-row')]
              .find((node) => node.textContent?.trim() === 'package-lock.json');
            if (!tracked) {
              if (Date.now() > deadline) return reject(new Error('tracked blame fixture missing'));
              return setTimeout(openTracked, 50);
            }
            tracked.click();
            const activateTracked = () => {
              const title = document.querySelector('.viewer-title')?.textContent || '';
              if (!title.includes('package-lock.json')) {
                if (Date.now() > deadline) return reject(new Error('large blame fixture did not activate'));
                return setTimeout(activateTracked, 50);
              }
              button('source')?.click();
              waitForSource();
            };
            activateTracked();
          };
          openTracked();
        })
      `),
      'Blame integration timed out',
      20000,
    )) as string
    console.log(`[smoke] lazy blame gutter OK (${blameStatus})`)

    const railNavigationStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const files = document.querySelector('.rail-nav button:nth-child(1)');
          const git = document.querySelector('.rail-nav button:nth-child(2)');
          const harness = document.querySelector('.rail-nav button:nth-child(3)');
          const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
            .find((node) => node.querySelector(':scope > .directory-row')
              ?.getAttribute('title')?.endsWith('/src'));
          if (!files || !git || !harness || !directory) {
            return reject(new Error('stable rail navigation controls missing'));
          }
          const directoryRow = directory.querySelector(':scope > .directory-row');
          if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
          const tabsBefore = document.querySelectorAll('.viewer-tab').length;
          git.click();
          files.click();
          git.click();
          files.click();
          requestAnimationFrame(() => {
            if (!directory.isConnected || directoryRow?.getAttribute('aria-expanded') !== 'true') {
              return reject(new Error('Files state was lost while switching rail views'));
            }
            if (document.querySelectorAll('.viewer-tab').length !== tabsBefore) {
              return reject(new Error('rail switching remounted viewer tabs'));
            }
            if (!files.classList.contains('active') || !harness.disabled) {
              return reject(new Error('rail active/reserved states are incorrect'));
            }
            resolve('stable tabs · Files state preserved · Harness reserved');
          });
        })
      `),
      'rail navigation did not preserve section state',
    )) as string
    console.log(`[smoke] rail navigation OK (${railNavigationStatus})`)

    const sessionFlowStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const sessionBar = document.querySelector('.session-bar');
        const sessionText = sessionBar?.textContent || '';
        if (sessionText.includes(${JSON.stringify(smokeRoot.path)})) {
          return reject(new Error('session strip still exposes the full project path'));
        }
        const change = [...(sessionBar?.querySelectorAll('button') || [])]
          .find((node) => node.textContent?.trim() === 'Change');
        const disconnect = [...(sessionBar?.querySelectorAll('button') || [])]
          .find((node) => node.textContent?.trim() === 'Disconnect');
        if (!change || disconnect) {
          return reject(new Error('local session actions are incorrect'));
        }
        change.click();
        const waitForHost = () => {
          const local = [...document.querySelectorAll('.session-host-option')]
            .find((node) => node.textContent?.includes('Local'));
          const choose = [...document.querySelectorAll('.project-dialog button')]
            .find((node) => node.textContent?.trim() === 'Choose folder');
          if (!local || !choose) {
            if (Date.now() > deadline) return reject(new Error('session host step missing'));
            return setTimeout(waitForHost, 50);
          }
          local.click();
          choose.click();
          const waitForFolder = () => {
            const path = document.querySelector('.folder-path-form input')?.value || '';
            const selected = document.querySelector('.folder-selection code')?.textContent || '';
            const selectedRow = document.querySelector('.folder-browser .directory-row.selected');
            const open = [...document.querySelectorAll('.project-dialog button')]
              .find((node) => node.textContent?.trim() === 'Open selected folder');
            const docs = [...document.querySelectorAll('.folder-browser .directory-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(`${smokeRoot.path}/docs`)});
            if (path && selected === path && selectedRow?.getAttribute('title') === path && open && docs) {
              docs.click();
              const waitForPicked = () => {
                const picked = document.querySelector('.folder-selection code')?.textContent || '';
                if (picked.endsWith('/docs')) {
                  const cancel = [...document.querySelectorAll('.project-dialog button')]
                    .find((node) => node.textContent?.trim() === 'Cancel');
                  cancel?.click();
                  return resolve('Local→connected→tree ' + picked);
                }
                if (Date.now() > deadline) return reject(new Error('tree folder selection failed'));
                setTimeout(waitForPicked, 25);
              };
              return waitForPicked();
            }
            if (Date.now() > deadline) return reject(new Error('session folder step missing'));
            setTimeout(waitForFolder, 50);
          };
          waitForFolder();
        };
        waitForHost();
      })
    `),
      'session flow timed out',
    )) as string
    console.log(`[smoke] staged session flow OK (${sessionFlowStatus})`)

    const resizeStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const tree = document.querySelector('.tree-panel');
          const terminal = document.querySelector('.terminal-panel');
          const treeDivider = document.querySelector('.tree-resizer');
          const terminalDivider = document.querySelector('.terminal-resizer');
          if (!tree || !terminal || !treeDivider || !terminalDivider) {
            return reject(new Error('pane dividers missing'));
          }
          const treeBefore = tree.getBoundingClientRect().width;
          const terminalBefore = terminal.getBoundingClientRect().height;
          if (terminalBefore < 325) {
            return reject(new Error('default terminal is too short for full-screen harnesses'));
          }
          treeDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          terminalDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const treeAfter = tree.getBoundingClientRect().width;
            const terminalAfter = terminal.getBoundingClientRect().height;
            if (treeAfter <= treeBefore || terminalAfter <= terminalBefore) {
              return reject(new Error('pane keyboard resize did not change tracks'));
            }
            treeDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            terminalDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            resolve(
              Math.round(treeBefore) + '→' + Math.round(treeAfter) + 'px tree; ' +
              Math.round(terminalBefore) + '→' + Math.round(terminalAfter) + 'px terminal'
            );
          }));
        })
      `),
      'pane resize controls did not respond',
    )) as string
    console.log(`[smoke] pane dividers OK (${resizeStatus})`)
    win.destroy()
    if (supervisor.list().length !== 0) {
      throw new Error('window close left an orphaned PTY')
    }
    console.log('[smoke] window close PTY cleanup OK')

    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    supervisor.disposeAll()
    await stopSmokeWatch?.()
    await host.exec('rm', ['-f', '--', liveReloadPath.path])
    await host.exec('rm', ['-f', '--', largeJsonPath.path])
    await host.dispose()
    worker.dispose()
    git.dispose()
  }
}

type EmitSmokeEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void

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

void app
  .whenReady()
  .then(async () => {
    htmlPreviews.register()
    if (process.env['HVIR_SMOKE']) {
      const code = await runSmoke()
      app.exit(code)
      return
    }
    await startup()
  })
  .catch((error: unknown) => {
    console.error('HVIR_STARTUP_FAIL', error)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void shutdown().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

async function suspendWorkbenchSessions(): Promise<void> {
  await stopProjectWatch()
  ptySupervisor?.disposeAll()
  htmlPreviews.clear()
  sshPrompter?.cancelAll()
  await projectRegistry?.disconnectSshHosts()
}

async function shutdown(): Promise<void> {
  sshPrompter?.cancelAll()
  await suspendSessions
  await stopProjectWatch().catch((error) =>
    console.error('[shutdown] watcher cleanup failed', error),
  )
  ptySupervisor?.disposeAll()
  ptySupervisor = null
  const registry = projectRegistry
  projectRegistry = null
  await registry
    ?.dispose()
    .catch((error) => console.error('[shutdown] host cleanup failed', error))
  sshPrompter = null
  echoWorker?.dispose()
  echoWorker = null
  gitWorker?.dispose()
  gitWorker = null
  htmlPreviews.dispose()
}
