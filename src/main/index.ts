/**
 * Main process entry.
 *
 * Wires the process model: creates the window, registers the typed IPC
 * contract, and spawns the echo utility process. Phase 1 ships an empty window;
 * every later feature plugs into the seams instantiated here.
 */

import { join } from 'node:path'
import { app, BrowserWindow, protocol, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import { LocalHost } from './project-host'
import { PtySupervisor } from './pty/pty-supervisor'
import {
  ECHO_REQUEST_TYPE,
  joinHostPath,
  localPath,
  type Disposer,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
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
let localHost: LocalHost | null = null
let ptySupervisor: PtySupervisor | null = null
let disposeWatch: Disposer | null = null

function createWindow(
  discardRendererResources: () => void = () => {
    ptySupervisor?.disposeAll()
    htmlPreviews.clear()
  },
): BrowserWindow {
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
  // Phase 2 has one renderer-owned terminal set. A renderer reload/crash cannot
  // run React cleanup, so main must end those PTYs rather than orphan shells.
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) discardRendererResources()
  })
  win.webContents.on('render-process-gone', discardRendererResources)
  win.on('closed', discardRendererResources)

  // Open external links in the OS browser, never in-app (security posture).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev (Vite dev server); in a
  // packaged build we load the built HTML from disk.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win
      .loadURL(rendererUrl)
      .catch((error) => console.error('[window] failed to load renderer URL', error))
  } else {
    void win
      .loadFile(join(__dirname, '../renderer/index.html'))
      .catch((error) => console.error('[window] failed to load renderer file', error))
  }

  return win
}

async function startup(): Promise<void> {
  echoWorker = createWorkerClient<EchoWorkerProtocol>(
    workerPath('echo-worker.js'),
    'hvir-echo',
  )
  gitWorker = createWorkerClient<GitWorkerProtocol>(
    workerPath('git-worker.js'),
    'hvir-git',
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
    gitWorker,
    host: localHost,
    root,
    ptySupervisor,
    htmlPreviews,
    emit,
  })
  const pendingWatchEvents = new Map<string, IpcEventPayload<'project:watch'>>()
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  const stopHostWatch = localHost.watch(
    root,
    (event) => {
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
    },
    {
      recursive: true,
      excludeDirectoryNames: ['.git', 'node_modules', 'out', 'dist'],
      onError: (error) => console.error('[watch] project watcher failed', error),
    },
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
  const git = createWorkerClient<GitWorkerProtocol>(
    workerPath('git-worker.js'),
    'hvir-git-smoke',
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
      host,
      root: smokeRoot,
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

    const win = createWindow(() => {
      supervisor.disposeAll()
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
                  if (document.querySelector('.mermaid-diagram svg') && document.querySelector('.markdown-body .shiki')) {
                    const body = document.querySelector('.markdown-body');
                    body?.dispatchEvent(new Event('scroll', { bubbles: true }));
                    return setTimeout(() => {
                      if (document.querySelector('.mermaid-diagram svg')) {
                        resolve('Shiki + Mermaid + stable scroll');
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
    const iframe = win.webContents.mainFrame.frames.find((frame) =>
      frame.url.startsWith(`${HTML_PREVIEW_SCHEME}://document/`),
    )
    if (!iframe) throw new Error('sandboxed HTML frame was not created')
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
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'S',
      modifiers: ['control'],
    })
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'S',
      modifiers: ['control'],
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

app.on('before-quit', () => {
  void disposeWatch?.()
  disposeWatch = null
  ptySupervisor?.disposeAll()
  ptySupervisor = null
  void localHost?.dispose()
  localHost = null
  echoWorker?.dispose()
  echoWorker = null
  gitWorker?.dispose()
  gitWorker = null
  htmlPreviews.dispose()
})
