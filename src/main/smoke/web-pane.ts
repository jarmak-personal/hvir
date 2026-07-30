import { createServer as createHttpServer } from 'node:http'

import { webContents, type BrowserWindow } from 'electron'

import { hostPathEquals, type HostPath, type ProjectState } from '../../shared'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'

/** Exercise the real hostile guest, authenticated route, and workspace visibility contract. */
export async function verifyWebPaneWorkflow(options: {
  readonly win: BrowserWindow
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly routes: WebPaneRouteRegistry
  readonly activeRoot: HostPath
  readonly switchRoot: HostPath
  readonly baseState: () => ProjectState
  readonly setState: (state: ProjectState) => void
  readonly emitState: (state: ProjectState) => void
  readonly interruptionCheckpoint: SmokeInterruptionCheckpoint
  readonly predecessorSelectionObserved: boolean
}): Promise<string> {
  const {
    win,
    supervisor,
    resources,
    routes,
    activeRoot,
    switchRoot,
    baseState,
    setState,
    emitState,
    interruptionCheckpoint,
    predecessorSelectionObserved,
  } = options
  const dashboardServer = createHttpServer()
  let dashboardRequests = 0
  try {
    const launchStatus = await ensureExplicitBareShellLaunch(win, supervisor)
    const sourceTerminal = supervisor
      .list()
      .find((terminal) => terminal.ownerId === win.webContents.id)
    if (!sourceTerminal) throw new Error('web pane source terminal was missing')

    dashboardServer.on('request', (request, response) => {
      dashboardRequests++
      if (request.url === '/sw.js') {
        response.writeHead(200, {
          'content-type': 'text/javascript',
          'service-worker-allowed': '/',
        })
        response.end(
          `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',(event)=>event.waitUntil(self.clients.claim()));self.addEventListener('message',(event)=>event.waitUntil(fetch('/sw-origin').then((response)=>response.text()).then((text)=>event.ports[0].postMessage(text))))`,
        )
        return
      }
      if (request.url === '/sw-origin') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('service-worker-route-ok')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      })
      response.end(
        `<!doctype html><title>smoke dashboard</title><input aria-label="dashboard input"><script>document.body.dataset.isolated=String(typeof require==='undefined'&&typeof window.hvir==='undefined');onbeforeunload=()=>"stay";navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then((registration)=>{const channel=new MessageChannel();channel.port1.onmessage=(event)=>document.body.dataset.serviceWorker=event.data;registration.active.postMessage('probe',[channel.port2])})</script>smoke-dashboard-ok`,
      )
    })
    await new Promise<void>((resolve, reject) => {
      dashboardServer.once('error', reject)
      dashboardServer.listen(0, '127.0.0.1', () => resolve())
    })
    const dashboardAddress = dashboardServer.address()
    if (!dashboardAddress || typeof dashboardAddress === 'string') {
      throw new Error('smoke dashboard server reported no port')
    }
    const dashboardUrl = `http://localhost:${dashboardAddress.port}/reef?tab=1`
    supervisor.write(
      sourceTerminal.id,
      sourceTerminal.ownerId,
      `printf '\\033[2J\\033[H%s\\n' '${dashboardUrl}'\r`,
    )

    const opened = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const poll = () => {
            const guest = document.querySelector('webview.web-pane-frame');
            const path = document.querySelector('.web-pane-path input');
            const tab = document.querySelector('.web-pane-tab');
            if (guest && path && tab) {
              if (path.value !== '/reef?tab=1') {
                return reject(new Error('web pane lost the link path: ' + path.value));
              }
              return resolve({ paneId: guest.getAttribute('name'), path: path.value });
            }
            if (Date.now() > deadline) {
              return reject(new Error('web pane never opened from the terminal link'));
            }
            const canvas = document.querySelector(
              '.terminal-deck:not([hidden]) .terminal-surface.active canvas'
            );
            if (canvas instanceof HTMLCanvasElement) {
              const rect = canvas.getBoundingClientRect();
              const clientX = rect.left + 24;
              const clientY = rect.top + 8;
              const mac = navigator.platform.includes('Mac');
              for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
                canvas.dispatchEvent(new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  clientX,
                  clientY,
                  button: 0,
                  buttons: type === 'mousedown' ? 1 : 0,
                  ctrlKey: !mac,
                  metaKey: mac
                }));
              }
            }
            setTimeout(poll, 50);
          };
          poll();
        })
      `),
      'terminal-link web pane activation timed out',
    )) as { paneId?: string; path: string }
    if (!opened.paneId) throw new Error('authorized web pane exposed no opaque pane id')

    const owner = resources.currentOwner(win.webContents.id)
    const provenance = routes.source(opened.paneId, owner.id, owner.generation)
    if (
      provenance?.terminalId !== sourceTerminal.id ||
      !hostPathEquals(provenance.workspaceRoot, activeRoot) ||
      provenance.hostId !== activeRoot.hostId
    ) {
      throw new Error(`web pane source provenance changed: ${JSON.stringify(provenance)}`)
    }
    await waitFor(
      () => dashboardRequests > 0,
      'authenticated web pane route never reached the dashboard server',
    )
    const dashboardGuest = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getType() === 'webview' &&
          !contents.isDestroyed() &&
          routes.paneIdForGuest(contents.id) === opened.paneId,
      )
    if (!dashboardGuest) throw new Error('authorized web pane guest was missing')
    await waitFor(async () => {
      try {
        return Boolean(
          await dashboardGuest.executeJavaScript(
            `document.body?.dataset.isolated === 'true' && document.body?.dataset.serviceWorker === 'service-worker-route-ok' && Boolean(document.querySelector('[aria-label="dashboard input"]'))`,
          ),
        )
      } catch {
        return false
      }
    }, 'isolated guest or service-worker route did not finish loading')

    const predecessorPaneId = interruptionCheckpoint.predecessorPaneId
    await interruptionCheckpoint.reach({
      name: 'web-route-ready',
      ownerGeneration: owner.generation,
      ptyCount: supervisor.list().length,
      routeOpen: routes.has(opened.paneId, owner.id, owner.generation),
      paneId: opened.paneId,
      loopbackPort: dashboardAddress.port,
      predecessorRouteObserved: Boolean(
        predecessorPaneId && routes.has(predecessorPaneId, owner.id, owner.generation),
      ),
      predecessorSelectionObserved,
    })

    await dashboardGuest.executeJavaScript(`window.__hvirPaneState = 'preserved'`)
    const guestId = dashboardGuest.id
    const switched = baseState()
    const switchedState: ProjectState = {
      ...switched,
      root: switchRoot,
      activeWorkspaceId: 'smoke-web-switch',
      projects: switched.projects.map((project) => ({
        ...project,
        activeWorkspaceId: 'smoke-web-switch',
        workspaces: [
          ...project.workspaces,
          {
            id: 'smoke-web-switch',
            root: switchRoot,
            name: 'docs',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      })),
    }
    setState(switchedState)
    emitState(switchedState)
    await rendererWait(
      win,
      `Boolean(document.querySelector('webview.web-pane-frame')) && !document.querySelector('.web-pane-tab')`,
      'inactive workspace did not hide its web pane',
    )

    const restored = baseState()
    setState(restored)
    emitState(restored)
    await rendererWait(
      win,
      `Boolean(document.querySelector('.web-pane-tab'))`,
      'web pane did not return with its workspace',
    )
    if (
      dashboardGuest.isDestroyed() ||
      dashboardGuest.id !== guestId ||
      (await dashboardGuest.executeJavaScript(`window.__hvirPaneState`)) !== 'preserved'
    ) {
      throw new Error('workspace switching reloaded or replaced the web pane guest')
    }

    await dashboardGuest.executeJavaScript(
      `document.querySelector('[aria-label="dashboard input"]').focus()`,
    )
    await dashboardGuest.insertText('typed-in-web-pane')
    const typedValue = (await dashboardGuest.executeJavaScript(
      `document.querySelector('[aria-label="dashboard input"]').value`,
    )) as string
    if (typedValue !== 'typed-in-web-pane') {
      throw new Error('ordinary web-pane text input was blocked')
    }

    await win.webContents.executeJavaScript(`
      (() => {
        const focus = [...document.querySelectorAll('.web-pane-toolbar button')]
          .find((button) => button.title === 'Full page');
        if (!focus) throw new Error('web pane full-page control was missing');
        focus.click();
      })()
    `)
    await rendererWait(
      win,
      `Boolean(document.querySelector('.workbench.web-focused'))`,
      'web pane did not enter full-page mode',
    )
    dashboardGuest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    dashboardGuest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await rendererWait(
      win,
      `!document.querySelector('.workbench.web-focused')`,
      'reserved Escape did not leave web-pane full-page mode',
    )

    await dashboardGuest
      .executeJavaScript(
        `location.assign('https://example.com/leave-hvir?token=secret#fragment'); true`,
      )
      .catch(() => undefined)
    const blockedNavigation = (await rendererValue(
      win,
      `(() => {
        const action = document.querySelector('.web-pane-navigation-blocked button');
        return action?.textContent?.includes('Open in system browser')
          ? action.textContent.trim()
          : undefined;
      })()`,
      'external navigation affordance was missing',
    )) as string
    await dashboardGuest.executeJavaScript(`console.warn('web-pane-smoke-warning')`)
    const diagnosticStatus = (await rendererValue(
      win,
      `(() => {
        const toggle = document.querySelector('[aria-label="Web pane diagnostics"]');
        if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click();
        const panel = document.querySelector('[aria-label="Web pane diagnostics"] + *');
        const diagnostics = document.querySelector('section[aria-label="Web pane diagnostics"]');
        const text = diagnostics?.textContent || panel?.textContent || '';
        if (!text.includes('web-pane-smoke-warning') || !text.includes('blocked-navigation')) {
          return undefined;
        }
        if (text.includes('token=secret') || text.includes('#fragment')) {
          throw new Error('web pane diagnostics exposed query or fragment values');
        }
        return 'bounded preview + redacted URL';
      })()`,
      'web pane diagnostics did not present reviewed bounded evidence',
    )) as string

    const closeModifier = process.platform === 'darwin' ? 'meta' : 'control'
    dashboardGuest.sendInputEvent({
      type: 'keyDown',
      keyCode: 'W',
      modifiers: [closeModifier],
    })
    dashboardGuest.sendInputEvent({
      type: 'keyUp',
      keyCode: 'W',
      modifiers: [closeModifier],
    })
    await rendererWait(
      win,
      `!document.querySelector('.web-pane-tab')`,
      'reserved close did not remove the web pane tab',
    )
    await waitFor(
      () => !routes.has(opened.paneId!, owner.id, owner.generation),
      'web pane close retained its authenticated route',
    )

    await win.webContents.executeJavaScript(
      `window.hvir.send('pty:kill', { id: ${JSON.stringify(sourceTerminal.id)} })`,
    )
    await waitFor(
      () => !supervisor.get(sourceTerminal.id),
      'web pane source terminal did not dispose after explicit close',
    )

    return [
      launchStatus,
      'authenticated + isolated guest',
      `source ${sourceTerminal.id}`,
      'workspace hide/restore',
      'usable input + full page',
      blockedNavigation,
      diagnosticStatus,
      'reserved close + route revoked',
    ].join(' · ')
  } catch (error) {
    const state = await readWebPaneState(win, supervisor)
    throw new Error(
      `Web pane workflow failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  } finally {
    if (dashboardServer.listening) {
      await new Promise<void>((resolve) => dashboardServer.close(() => resolve()))
    }
  }
}

async function readWebPaneState(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<unknown> {
  let renderer: unknown = { unavailable: true }
  try {
    if (!win.isDestroyed()) {
      renderer = await win.webContents.executeJavaScript(`
        (() => ({
          paneId: document.querySelector('webview.web-pane-frame')?.getAttribute('name'),
          path: document.querySelector('.web-pane-path input')?.value,
          tab: document.querySelector('.web-pane-tab')?.textContent?.trim().slice(0, 120),
          fullPage: Boolean(document.querySelector('.workbench.web-focused')),
          blocked: document.querySelector('.web-pane-navigation-blocked')
            ?.textContent?.trim().slice(0, 160),
          diagnostics: document.querySelector('section[aria-label="Web pane diagnostics"]')
            ?.textContent?.trim().slice(0, 240)
        }))()
      `)
    }
  } catch {
    // Preserve the original failure when the renderer is unavailable.
  }
  return {
    renderer,
    terminals: supervisor.list().map(({ id, hostId, workspaceRoot }) => ({
      id,
      hostId,
      workspaceRoot,
    })),
  }
}

async function rendererWait(
  win: BrowserWindow,
  expression: string,
  message: string,
): Promise<void> {
  await rendererValue(win, `(${expression}) ? true : undefined`, message)
}

function rendererValue(
  win: BrowserWindow,
  expression: string,
  message: string,
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        try {
          const value = ${expression};
          if (value) return resolve(value);
        } catch (error) {
          return reject(error);
        }
        if (Date.now() > deadline) return reject(new Error(${JSON.stringify(message)}));
        setTimeout(poll, 25);
      };
      poll();
    })
  `) as Promise<unknown>
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function withTimeout<T>(
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
