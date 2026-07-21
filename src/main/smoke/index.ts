import { app, webContents, type BrowserWindow } from 'electron'

import { dispatchWorkerHostCall } from '../git/worker-host-broker'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import { harnessProviderCatalog } from '../harness/harness-provider'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import { registerIpcHandlers } from '../ipc'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import type { TerminalSessionStore } from '../terminal/session-registry'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import { createWorkerClient, workerPath } from '../worker-host'
import { SmokeCleanup } from './cleanup'
import { verifyGitDiffBehavior } from './git-diff'
import { verifyRendererLifecycleCleanup } from './renderer-lifecycle'
import { verifyViewerPositions } from './viewer-position'
import { createTerminalMoveSmokeHarness, verifyTerminalMoveSmoke } from './terminal-move'
import {
  ECHO_REQUEST_TYPE,
  HTML_PREVIEW_SCHEME,
  MAX_PROJECT_WATCH_INTERESTS,
  asHarnessProfileId,
  asHostId,
  hostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  type Disposer,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  type KeybindingMap,
  type ProjectState,
  type TerminalRecoverySession,
} from '../../shared'

export type ElectronSmokeMode = 'workflow' | 'capacity'

export interface ElectronSmokeDependencies {
  readonly mode: ElectronSmokeMode
  readonly createWindow: (
    discardRendererResources?: (ownerId: number) => void,
  ) => BrowserWindow
  readonly harnessProbeManager: HarnessProbeManager
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly rendererResources: RendererResourceScopes
  readonly webPaneRoutes: WebPaneRouteRegistry
  readonly updateWebPaneBindings: (ownerId: number, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (ownerId: number, paneId?: string) => void
  readonly openExternal: (url: string) => Promise<void>
}

/** Production-composed Electron acceptance workflow selected by `HVIR_SMOKE=1`. */
export async function runSmoke(dependencies: ElectronSmokeDependencies): Promise<number> {
  const {
    createWindow,
    harnessProbeManager,
    htmlPreviews,
    rendererResources,
    mode,
    openExternal,
    updateWebPaneBindings,
    updateWebPaneFullPage,
    webPaneRoutes,
  } = dependencies
  const defaultHarnessProviderId = harnessProviderCatalog().find(
    (provider) => provider.default,
  )!.id
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
  const smokeCloseableRoot = joinHostPath(smokeRoot, '.hvir-smoke-closed-project')
  const smokeWebSwitchRoot = joinHostPath(smokeRoot, 'docs')
  const cleanup = new SmokeCleanup()
  cleanup.defer('echo worker', () => worker.dispose())
  cleanup.defer('Git worker', () => git.dispose())
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('harness profile fixture', () =>
    host.exec('rm', ['-f', '--', harnessProfilesPath.path]).then(() => undefined),
  )
  cleanup.defer('large text fixture', () =>
    host.exec('rm', ['-f', '--', largeTextPath.path]).then(() => undefined),
  )
  cleanup.defer('large JSON fixture', () =>
    host.exec('rm', ['-f', '--', largeJsonPath.path]).then(() => undefined),
  )
  cleanup.defer('live reload fixture', () =>
    host.exec('rm', ['-f', '--', liveReloadPath.path]).then(() => undefined),
  )
  cleanup.defer('viewer position fixture', () =>
    host.exec('rm', ['-f', '--', viewerPositionPath.path]).then(() => undefined),
  )
  cleanup.defer('project watch', async () => stopSmokeWatch?.())
  cleanup.defer('supervised terminals', () => supervisor.disposeAllAndWait())
  cleanup.defer('smoke window', async () => {
    if (!smokeWindow || smokeWindow.isDestroyed()) return
    const ownerId = smokeWindow.webContents.id
    await webPaneRoutes.closeOwner(ownerId)
    smokeWindow.destroy()
  })
  const smokeProjectState = (
    connectionState = host.connectionState,
    missing = false,
  ): ProjectState => ({
    root: smokeRoot,
    connectionState,
    watchTier: host.watchTier,
    activeProjectId: 'smoke-project',
    activeWorkspaceId: 'smoke-workspace',
    projects: [
      {
        id: 'smoke-project',
        registeredRoot: smokeRoot,
        displayName: 'hvir',
        connectionState,
        watchTier: host.watchTier,
        activeWorkspaceId: 'smoke-workspace',
        workspaces: [
          {
            id: 'smoke-workspace',
            root: smokeRoot,
            name: 'hvir',
            main: true,
            missing,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const smokeRemoteRoot = hostPath(asHostId('smoke-remote'), '/srv/hvir')
  const smokeRemoteProjectState = (): ProjectState => ({
    // Present remote chrome without widening the mounted local host authority.
    root: smokeRoot,
    connectionState: 'connected',
    watchTier: 'polling',
    activeProjectId: 'smoke-remote-project',
    activeWorkspaceId: 'smoke-workspace',
    projects: [
      {
        id: 'smoke-remote-project',
        registeredRoot: smokeRemoteRoot,
        displayName: 'remote-hvir',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'smoke-workspace',
        workspaces: [
          {
            id: 'smoke-workspace',
            root: smokeRoot,
            name: 'feature/header',
            main: true,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const liveReloadPath = joinHostPath(smokeRoot, '.hvir-smoke-live.txt')
  const viewerPositionPath = joinHostPath(smokeRoot, '.hvir-smoke-position.md')
  const largeJsonPath = joinHostPath(smokeRoot, '.hvir-smoke-large.json')
  const largeTextPath = joinHostPath(smokeRoot, '.hvir-smoke-large.txt')
  const harnessProfilesPath = joinHostPath(smokeRoot, '.hvir-smoke-harness-profiles.json')
  try {
    const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
    if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
    if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
    console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)

    // Exercise the real renderer → main → worker path.
    await host.connect()
    await host.exec('rm', ['-f', '--', harnessProfilesPath.path])
    const liveReloadBefore = `${Array.from({ length: 240 }, (_, index) => `line ${index}`).join('\n')}\n`
    await host.writeFile(liveReloadPath, liveReloadBefore)
    await host.writeFile(
      viewerPositionPath,
      Array.from(
        { length: 80 },
        (_, index) => `## Position ${index + 1}\n\nParagraph ${index + 1}\n`,
      ).join('\n'),
    )
    await host.writeFile(
      largeJsonPath,
      JSON.stringify(
        Array.from({ length: 50_000 }, (_, index) => ({
          id: index,
          value: `item-${index}`,
        })),
      ),
    )
    await host.writeFile(
      largeTextPath,
      `${'large file responsiveness fixture 0123456789\n'.repeat(135_000)}end\n`,
    )
    const emit: EmitSmokeEvent = (channel, payload) => {
      if (smokeWindow && !smokeWindow.isDestroyed()) {
        smokeWindow.webContents.send(channel, payload)
      }
    }
    let smokeRecoverySessions: readonly TerminalRecoverySession[] = []
    const smokeTerminalSessions: TerminalSessionStore = {
      list: () => smokeRecoverySessions,
      recordSpawn: () => Promise.resolve(),
      recordIdentity: () => Promise.resolve(),
      updateLayout: () => Promise.resolve(),
      forget: () => Promise.resolve(),
      rebindProfile: () => Promise.reject(new Error('Smoke recovery is read-only')),
      authorizeResume: () => false,
      flush: () => Promise.resolve(),
    }
    const smokeHarnessProfiles = await HarnessProfileStore.load(host, harnessProfilesPath)
    let smokeIpcProjectState = smokeProjectState()
    const terminalMoveSmoke = createTerminalMoveSmokeHarness({
      sourceState: smokeProjectState,
      targetRoot: smokeWebSwitchRoot,
      supervisor,
      resources: rendererResources,
      webPanes: webPaneRoutes,
      onState: (state) => {
        smokeIpcProjectState = state
      },
    })
    const ipcRouter = registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      getProject: () => ({ host, root: smokeRoot }),
      getHost: () => host,
      connectedHosts: () => [host],
      getRegisteredWorkspaceRoot: (root) =>
        hostPathEquals(root, smokeRoot) ||
        hostPathEquals(root, smokeCloseableRoot) ||
        hostPathEquals(root, smokeWebSwitchRoot)
          ? root
          : undefined,
      getProjectState: () => smokeIpcProjectState,
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
      openProject: () => Promise.resolve(smokeProjectState()),
      switchWorkspace: () => Promise.resolve(smokeProjectState()),
      refreshProject: () => Promise.resolve(smokeProjectState()),
      updateWatchInterests: (paths) =>
        Promise.resolve({
          accepted: Math.min(paths.length, MAX_PROJECT_WATCH_INTERESTS),
          limited: paths.length > MAX_PROJECT_WATCH_INTERESTS,
        }),
      closeProject: () => {
        smokeIpcProjectState = smokeProjectState()
        return Promise.resolve(smokeIpcProjectState)
      },
      pruneWorktrees: () => Promise.resolve(smokeProjectState()),
      dismissWorkspace: () => Promise.resolve(smokeProjectState()),
      acknowledgeWorkspace: () => Promise.resolve(smokeProjectState()),
      switchGitBranch: () => Promise.resolve(smokeProjectState()),
      fetchGit: () => Promise.resolve(smokeProjectState()),
      pullGit: () => Promise.resolve(smokeProjectState()),
      respondSshPrompt: () => undefined,
      rendererResources,
      rendererReady: () => undefined,
      ptySupervisor: supervisor,
      terminalSessions: smokeTerminalSessions,
      terminalMoves: terminalMoveSmoke.coordinator,
      harnessProfiles: smokeHarnessProfiles,
      harnessProbes: harnessProbeManager,
      updateAttention: () => undefined,
      updateWebPaneBindings: (owner, bindings) =>
        updateWebPaneBindings(owner.id, bindings),
      updateWebPaneFullPage: (owner, paneId) => updateWebPaneFullPage(owner.id, paneId),
      htmlPreviews,
      webPanes: webPaneRoutes,
      openExternal,
      emit,
    })
    cleanup.defer('IPC authority router', () => ipcRouter.dispose())
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

    const win = createWindow()
    smokeWindow = win
    await withTimeout(
      new Promise<void>((resolve) => win.once('ready-to-show', resolve)),
      'window never became ready',
    )
    const initialRendererGeneration = rendererResources.currentOwner(
      win.webContents.id,
    ).generation
    console.log('[smoke] window ready-to-show OK')

    // A real preload round-trip establishes more than ready-to-show paint.
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

    const profileSmoke = (await withTimeout(
      win.webContents.executeJavaScript(`
        (async () => {
          const root = ${JSON.stringify(smokeRoot)};
          const defaults = await window.hvir.invoke('harness:profiles', { root });
          const catalog = await window.hvir.invoke('harness:catalog', undefined);
          const requestedProviderIds = catalog
            .filter((provider) => provider.profileTemplate && !provider.default)
            .slice(0, 2)
            .map((provider) => provider.id);
          const customProviderId = catalog.find(
            (provider) => !provider.profileTemplate
          )?.id;
          if (!customProviderId) throw new Error('Custom provider was missing');
          const materialized = await window.hvir.invoke('harness:profile-materialize', {
            root,
            providerIds: [...requestedProviderIds].reverse()
          });
          const grant = await window.hvir.invoke('harness:authorize-path', {
            root,
            path: root
          });
          const profile = await window.hvir.invoke('harness:profile-save', {
            root,
            input: {
              displayName: 'Smoke custom harness',
              providerId: customProviderId,
              scope: { kind: 'project', projectRoot: root },
              executable: { kind: 'command', command: 'sh' },
              args: [
                { parts: [{ kind: 'literal', value: '-c' }] },
                { parts: [{ kind: 'literal', value: 'printf hvir-profile-smoke; exec /bin/sh' }] },
                { parts: [{ kind: 'path', source: 'binding', binding: 'workspace' }] }
              ],
              environment: [
                { kind: 'literal', name: 'HVIR_PROFILE_SMOKE', value: 'structured' }
              ],
              pathBindings: [
                { name: 'workspace', path: grant.path, grantId: grant.id }
              ],
              order: 20
            }
          });
          const acknowledgedProfile = await window.hvir.invoke(
            'harness:acknowledge-risk',
            { root, id: profile.id, launchRevision: profile.launchRevision }
          );
          const preview = await window.hvir.invoke('harness:preview', {
            root,
            cwd: root,
            mode: 'fresh',
            profileId: profile.id,
            launchRevision: profile.launchRevision
          });
          let output = '';
          const stopOutput = window.hvir.on('pty:data', ({ id, data }) => {
            if (id === 'profile-smoke-terminal') output += data;
          });
          const started = await window.hvir.invoke('pty:start', {
            sessionId: 'profile-smoke-terminal',
            profileId: profile.id,
            launchRevision: profile.launchRevision,
            cwd: root,
            cols: 80,
            rows: 24,
            title: 'Smoke custom harness',
            position: 20,
            active: false,
            composerSubmitMode: 'enter',
            acknowledgeRisk: true
          });
          await new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const poll = () => {
              if (output.includes('hvir-profile-smoke')) return resolve();
              if (Date.now() >= deadline) {
                return reject(new Error('Custom profile output was not observed'));
              }
              setTimeout(poll, 25);
            };
            poll();
          });
          stopOutput();
          return {
            defaultIds: defaults.map((candidate) => candidate.id),
            requestedProviderIds,
            materialized: materialized.map((candidate) => ({
              id: candidate.id,
              providerId: candidate.providerId,
              builtIn: candidate.builtIn,
              scope: candidate.scope.kind
            })),
            profile: acknowledgedProfile,
            preview,
            started,
            output
          };
        })()
      `),
      'structured harness profile smoke timed out',
    )) as {
      defaultIds: readonly string[]
      requestedProviderIds: readonly string[]
      materialized: readonly {
        id: string
        providerId: string
        builtIn: boolean
        scope: string
      }[]
      profile: {
        id: string
        risk: string
        launchRevision: number
        riskAcknowledgedRevision?: number
      }
      preview: { args: readonly string[]; command: string }
      started: { id: string; identityStatus: string; resumed: boolean }
      output: string
    }
    if (
      profileSmoke.defaultIds.join(',') !== 'plain-shell-default' ||
      profileSmoke.materialized.map(({ providerId }) => providerId).join(',') !==
        profileSmoke.requestedProviderIds.join(',') ||
      profileSmoke.materialized.some(
        ({ id, builtIn, scope }) =>
          id.endsWith('-default') || builtIn || scope !== 'global',
      )
    ) {
      throw new Error(
        `opt-in harness profile materialization was incorrect (${JSON.stringify({
          defaultIds: profileSmoke.defaultIds,
          requestedProviderIds: profileSmoke.requestedProviderIds,
          materialized: profileSmoke.materialized,
        })})`,
      )
    }
    if (
      profileSmoke.profile.risk !== 'unclassified' ||
      profileSmoke.profile.riskAcknowledgedRevision !==
        profileSmoke.profile.launchRevision ||
      profileSmoke.started.identityStatus !== 'none' ||
      profileSmoke.started.resumed ||
      !profileSmoke.output.includes('hvir-profile-smoke') ||
      !profileSmoke.preview.args.includes(smokeRoot.path) ||
      !profileSmoke.preview.command.includes("HVIR_PROFILE_SMOKE='structured'")
    ) {
      throw new Error(
        'structured Custom profile did not preserve preview/launch semantics',
      )
    }
    const profileTerminal = supervisor.get(profileSmoke.started.id)
    if (!profileTerminal) throw new Error('Custom profile PTY was not supervised')
    supervisor.kill(profileTerminal.id, profileTerminal.ownerId)
    await smokeWaitFor(
      () => supervisor.get(profileTerminal.id) === undefined,
      'Custom profile PTY did not exit',
    )
    console.log('[smoke] structured profile preview + Custom PTY OK')

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

    // Activate an agent-like server through a real rendered terminal link.
    const { createServer: createHttpServer } = await import('node:http')
    let dashboardRequests = 0
    const dashboardServer = createHttpServer((request, response) => {
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
        `<!doctype html><title>smoke dashboard</title><input aria-label="dashboard input"><script>onbeforeunload=()=>"stay";navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then((registration)=>{const channel=new MessageChannel();channel.port1.onmessage=(event)=>document.body.dataset.serviceWorker=event.data;registration.active.postMessage('probe',[channel.port2])})</script>smoke-dashboard-ok`,
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
    const dashboardPort = dashboardAddress.port
    try {
      const sourceTerminal = supervisor
        .list()
        .find((terminal) => terminal.ownerId === win.webContents.id)
      if (!sourceTerminal) throw new Error('web pane source terminal was missing')
      const dashboardUrl = `http://localhost:${dashboardPort}/reef?tab=1`
      supervisor.write(
        sourceTerminal.id,
        sourceTerminal.ownerId,
        `printf '\\033[2J\\033[H%s\\n' '${dashboardUrl}'\r`,
      )
      const linkPaneStatus = (await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 8000
            const poll = () => {
              const tab = document.querySelector('.web-pane-tab')
              const guest = document.querySelector('webview.web-pane-frame')
              const path = document.querySelector('.web-pane-path input')
              if (tab && guest && path) {
                if (path.value !== '/reef?tab=1') {
                  return reject(new Error('web pane lost the link path: ' + path.value))
                }
                return resolve('opened')
              }
              if (Date.now() > deadline) {
                return reject(new Error('web pane never opened from the link'))
              }
              const canvas = document.querySelector(
                '.terminal-deck:not([hidden]) .terminal-surface.active canvas'
              )
              if (canvas instanceof HTMLCanvasElement) {
                const rect = canvas.getBoundingClientRect()
                const clientX = rect.left + 24
                const clientY = rect.top + 8
                const mac = navigator.platform.includes('Mac')
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
                  }))
                }
              }
              setTimeout(poll, 100)
            }
            setTimeout(poll, 300)
          })
        `),
        'link-to-pane smoke timed out',
      )) as string
      await withTimeout(
        (async () => {
          while (dashboardRequests === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        })(),
        'web pane never reached the dashboard server',
      )
      const dashboardGuest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview' && !contents.isDestroyed())
      if (!dashboardGuest) throw new Error('authorized web pane guest was missing')
      await withTimeout(
        (async () => {
          for (;;) {
            const ready: unknown = await dashboardGuest
              .executeJavaScript(
                `document.body?.dataset.serviceWorker === 'service-worker-route-ok' && Boolean(document.querySelector('[aria-label="dashboard input"]'))`,
              )
              .catch(() => false)
            if (ready) return
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          }
        })(),
        'web pane guest or service-worker route did not finish loading',
      )
      await dashboardGuest.executeJavaScript(`window.__hvirPaneState = 'preserved'`)
      const requestsBeforeSwitch = dashboardRequests
      const switchedState = smokeProjectState()
      smokeIpcProjectState = {
        ...switchedState,
        root: smokeWebSwitchRoot,
        activeWorkspaceId: 'smoke-web-switch',
        projects: switchedState.projects.map((project) => ({
          ...project,
          activeWorkspaceId: 'smoke-web-switch',
          workspaces: [
            ...project.workspaces,
            {
              id: 'smoke-web-switch',
              root: smokeWebSwitchRoot,
              name: 'docs',
              main: false,
              missing: true,
              repository: true,
              changedFiles: 0,
            },
          ],
        })),
      }
      emit('project:state', smokeIpcProjectState)
      await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000
            const poll = () => {
              const guest = document.querySelector('webview.web-pane-frame')
              if (guest && !document.querySelector('.web-pane-tab')) return resolve()
              if (Date.now() > deadline) {
                return reject(new Error('inactive workspace did not hide its web pane'))
              }
              setTimeout(poll, 25)
            }
            poll()
          })
        `),
        'web pane workspace-hide smoke timed out',
      )
      // Let the unavailable synthetic workspace finish ordinary recovery reads.
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      smokeIpcProjectState = smokeProjectState()
      emit('project:state', smokeIpcProjectState)
      await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000
            const poll = () => {
              if (document.querySelector('.web-pane-tab')) return resolve()
              if (Date.now() > deadline) {
                return reject(new Error('web pane did not return with its workspace'))
              }
              setTimeout(poll, 25)
            }
            poll()
          })
        `),
        'web pane workspace-return smoke timed out',
      )
      const preservedPaneState = (await dashboardGuest.executeJavaScript(
        `window.__hvirPaneState`,
      )) as string
      if (
        preservedPaneState !== 'preserved' ||
        dashboardRequests !== requestsBeforeSwitch
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
            .find((button) => button.title === 'Full page')
          if (!focus) throw new Error('web pane full-page control was missing')
          focus.click()
        })()
      `)
      await withTimeout(
        (async () => {
          for (;;) {
            const focused = (await win.webContents.executeJavaScript(
              `Boolean(document.querySelector('.workbench.web-focused'))`,
            )) as boolean
            if (focused) return
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          }
        })(),
        'web pane did not enter full-page mode',
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      dashboardGuest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      dashboardGuest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await withTimeout(
        (async () => {
          for (;;) {
            const focused = (await win.webContents.executeJavaScript(
              `Boolean(document.querySelector('.workbench.web-focused'))`,
            )) as boolean
            if (!focused) return
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          }
        })(),
        'reserved Escape did not leave web-pane full-page mode',
      )
      await dashboardGuest
        .executeJavaScript(`location.assign('https://example.com/leave-hvir'); true`)
        .catch(() => undefined)
      const blockedNavigation = (await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000
            const poll = () => {
              const action = document.querySelector('.web-pane-navigation-blocked button')
              if (action?.textContent?.includes('Open in system browser')) {
                return resolve(action.textContent.trim())
              }
              if (Date.now() > deadline) {
                return reject(new Error('external navigation affordance was missing'))
              }
              setTimeout(poll, 50)
            }
            poll()
          })
        `),
        'blocked web navigation smoke timed out',
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
      const linkPaneClosed = (await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000
            const poll = () => {
              if (!document.querySelector('.web-pane-tab')) return resolve('closed')
              if (Date.now() > deadline) {
                return reject(new Error('web pane tab did not close'))
              }
              setTimeout(poll, 50)
            }
            poll()
          })
        `),
        'web pane close smoke timed out',
      )) as string
      if (
        linkPaneStatus !== 'opened' ||
        typedValue !== 'typed-in-web-pane' ||
        blockedNavigation !== 'Open in system browser' ||
        linkPaneClosed !== 'closed'
      ) {
        throw new Error('web pane link flow did not complete')
      }
      console.log(
        '[smoke] terminal link → isolated web pane → workspace preserve → blocked external affordance → reserved close OK',
      )
    } finally {
      await new Promise<void>((resolve) => dashboardServer.close(() => resolve()))
    }

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

    // Wait for Ghostty WASM, native node-pty, and the lazy tree.
    const terminalStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const poll = () => {
            const status = document.querySelector('.terminal-panel')?.getAttribute('data-terminal-status') || '';
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

    const terminalCaretStatus = (await win.webContents.executeJavaScript(`
      (() => {
        const host = document.querySelector('.terminal-container');
        if (!(host instanceof HTMLElement)) throw new Error('terminal input host missing');
        const panel = host.closest('.terminal-panel');
        if (!(panel instanceof HTMLElement)) throw new Error('terminal panel missing');
        if (panel.querySelector(':scope > .panel-header')) {
          throw new Error('redundant terminal header is still mounted');
        }
        if (Math.abs(panel.getBoundingClientRect().top - host.getBoundingClientRect().top) > 1) {
          throw new Error('terminal canvas does not begin at the deck edge');
        }
        const rail = document.querySelector('.terminal-rail');
        if (!(rail instanceof HTMLElement)) throw new Error('terminal rail missing');
        if (parseFloat(getComputedStyle(rail).borderLeftWidth) !== 0) {
          throw new Error('terminal rail divider cannot open at the active entry');
        }
        const activeRow = rail.querySelector('.terminal-list-row.active');
        if (!(activeRow instanceof HTMLElement)) throw new Error('active terminal row missing');
        if (parseFloat(getComputedStyle(activeRow).borderTopLeftRadius) !== 0) {
          throw new Error('active terminal row still narrows its opening');
        }
        const activeBackground = getComputedStyle(activeRow).backgroundImage;
        if (!activeBackground.includes('linear-gradient') || !activeBackground.includes('80%')) {
          throw new Error('active terminal entry does not blend into the canvas');
        }
        host.focus();
        const hostStyle = getComputedStyle(host);
        const caret = hostStyle.caretColor;
        if (caret !== 'transparent' && caret !== 'rgba(0, 0, 0, 0)') {
          throw new Error('browser caret is visible in terminal input host: ' + caret);
        }
        const canvas = host.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('terminal canvas missing');
        const hostRect = host.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const workbench = host.closest('.workbench');
        if (!(workbench instanceof HTMLElement)) throw new Error('terminal workbench missing');
        const workbenchRect = workbench.getBoundingClientRect();
        if (
          Math.abs(workbenchRect.bottom - window.innerHeight) > 1 ||
          Math.abs(hostRect.bottom - window.innerHeight) > 1
        ) {
          throw new Error(
            'terminal extends outside the viewport: viewport=' + window.innerHeight +
            ' workbench=' + workbenchRect.bottom + ' terminal=' + hostRect.bottom
          );
        }
        const paddingRight = parseFloat(hostStyle.paddingRight) || 0;
        const paddingBottom = parseFloat(hostStyle.paddingBottom) || 0;
        const rightRemainder = hostRect.right - paddingRight - canvasRect.right;
        const bottomRemainder = hostRect.bottom - paddingBottom - canvasRect.bottom;
        if (rightRemainder < -1 || bottomRemainder < -1) {
          throw new Error(
            'terminal canvas exceeds its content box: right=' + rightRemainder +
            ' bottom=' + bottomRemainder
          );
        }
        if (rightRemainder >= 12 || bottomRemainder >= 20) {
          throw new Error(
            'terminal fit wastes more than one cell: right=' + rightRemainder +
            ' bottom=' + bottomRemainder
          );
        }
        return 'headerless · canvas cursor only · fit ' +
          rightRemainder.toFixed(1) + '×' + bottomRemainder.toFixed(1) + 'px';
      })()
    `)) as string
    console.log(`[smoke] terminal input caret contained (${terminalCaretStatus})`)

    const terminalMoveStatus = await verifyTerminalMoveSmoke({
      win,
      supervisor,
      harness: terminalMoveSmoke,
      emitState: (state) => emit('project:state', state),
    })
    console.log(`[smoke] live terminal worktree move OK (${terminalMoveStatus})`)

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
        await rendererResources.revokeWorkspace(smokeRoot)
        emit('project:state', smokeProjectState('disconnected'))
        await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const poll = () => {
              const container = document.querySelector('.terminal-container');
              const status = document.querySelector('.terminal-panel')?.getAttribute('data-terminal-status') || '';
              if (container?.childElementCount === 0 && status === 'disconnected') return resolve(true);
              if (Date.now() > deadline) return reject(new Error('terminal did not clear on disconnect'));
              setTimeout(poll, 25);
            };
            poll();
          })
        `)
        emit('project:state', smokeProjectState('connected'))
        const status: unknown = await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            let lastState = 'not mounted';
            const poll = () => {
              const canvas = document.querySelector('.terminal-container canvas');
              const host = document.querySelector('.terminal-container');
              const status = document.querySelector('.terminal-panel')?.getAttribute('data-terminal-status') || '';
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
          let menuOpened = false;
          const waitForSecond = () => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const surfaces = [...document.querySelectorAll('.terminal-surface')];
            const active = document.querySelector('.terminal-surface.active');
            const status = active?.getAttribute('data-terminal-status') || '';
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
            const add = document.querySelector('button[aria-label="New terminal"]');
            if (!menuOpened && add && !add.disabled) {
              add.click();
              menuOpened = true;
            }
            const shell = [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell');
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
      // Keep the OSC-title fixture ahead of CI shells resetting at their prompt.
      "printf '\\033]0;Smoke agent\\007\\007'; sleep 10\n",
    )
    const terminalSignalStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const title = rows[1]?.querySelector('.terminal-list-title')?.textContent || '';
            const bell = rows[1]?.querySelector('.terminal-attention-badge.bell');
            if (title === 'Smoke agent' && bell) {
              rows[1]?.querySelector('.terminal-close-button')?.click();
              return resolve('live title · bell badge · close');
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
    if (mode === 'capacity') {
      await runCapacityLoadSmoke(win, supervisor, host, liveReloadPath)
      smokeRecoverySessions = supervisor.list().map((terminal, position) => ({
        id: terminal.id,
        providerId: defaultHarnessProviderId,
        profileId: asHarnessProfileId('plain-shell-default'),
        launchRevision: 1,
        hostId: terminal.hostId,
        cwd: terminal.cwd,
        title: `Recovered capacity shell ${position + 1}`,
        position,
        active: position === 0,
        updatedAt: Date.now(),
      }))
      await runCapacityRecoverySmoke(win, supervisor)
      console.log('HVIR_SMOKE_OK')
      return 0
    }

    const viewerStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const poll = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) =>
                node.querySelector('.tree-file-name')?.textContent?.trim() === 'AGENTS.md'
              );
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
                const sourceDeadline = Date.now() + 20000;
                const waitForSource = () => {
                  const status = document.querySelector('.source-meta')?.textContent || '';
                  if (document.querySelector('.cm-editor') && status.includes('markdown')) {
                    return resolve('rendered→source · ' + status);
                  }
                  if (Date.now() > sourceDeadline) return reject(new Error('source highlight timed out: ' + status));
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
      40_000,
    )) as string
    console.log(`[smoke] ProjectHost tree + CodeMirror/Shiki worker OK (${viewerStatus})`)

    const renderedFixture = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 30000;
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
                    const renderedTab = [...document.querySelectorAll('.viewer-tab')]
                      .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
                    renderedTab?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
                  if (Date.now() > deadline) return reject(new Error(
                    'rendered fixture timed out: mermaid=' + Boolean(document.querySelector('.mermaid-diagram svg')) +
                    ' shiki=' + Boolean(document.querySelector('.markdown-body .shiki')) +
                    ' image=' + Boolean(image) + '/' + (image?.complete ? image.naturalWidth : 'pending') +
                    ' tasks=' + tasks.length
                  ));
                  setTimeout(waitForRendered, 50);
                };
                waitForRendered();
              })
            )
          );
        })
      `),
      'Markdown Mermaid fixture did not render',
      35000,
    )) as string
    console.log(`[smoke] rendered Markdown fixture OK (${renderedFixture})`)

    const richerViewerStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('richer viewer fixture missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test/fixtures/rendered.csv', () => {
            const waitForCsv = () => {
              const cells = [...document.querySelectorAll('.csv-view td')]
                .map((node) => node.textContent || '');
              if (cells.includes('Ada Lovelace') && cells.includes('compiler pioneer')) {
                openWhenReady('/test/fixtures/rendered-image.svg', () => {
                  const waitForImage = () => {
                    const image = document.querySelector('.image-view img');
                    if (image?.getAttribute('src')?.startsWith('blob:') && image.complete) {
                      return resolve('worker CSV table + repository image view');
                    }
                    if (Date.now() > deadline) return reject(new Error('image view timed out'));
                    setTimeout(waitForImage, 50);
                  };
                  waitForImage();
                });
                return;
              }
              if (Date.now() > deadline) return reject(new Error('CSV table timed out'));
              setTimeout(waitForCsv, 50);
            };
            waitForCsv();
          });
        })
      `),
      'CSV/image viewer smoke timed out',
    )) as string
    console.log(`[smoke] richer rendered views OK (${richerViewerStatus})`)

    const themeStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const initial = document.documentElement.dataset.theme;
          const canvas = document.querySelector('.terminal-container canvas');
          const terminal = canvas?.closest('.terminal-container');
          const toggle = document.querySelector('.theme-toggle');
          const shell = document.querySelector('.app-shell');
          if (!canvas || !terminal || !toggle || !shell) return reject(new Error('theme smoke controls missing'));
          const terminalBackgroundMatches = () => {
            const expected = terminal.getAttribute('data-terminal-theme') === 'light'
              ? 'rgb(236, 236, 231)'
              : 'rgb(17, 19, 24)';
            return getComputedStyle(terminal).backgroundColor === expected;
          };
          const before = getComputedStyle(shell).backgroundColor;
          const terminalBefore = getComputedStyle(canvas).filter;
          if (!terminalBackgroundMatches()) {
            return reject(new Error('terminal host background does not match its palette'));
          }
          toggle.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const current = document.documentElement.dataset.theme;
            const after = getComputedStyle(shell).backgroundColor;
            const terminalAfter = getComputedStyle(canvas).filter;
            if (current === initial || before === after) {
              return reject(new Error('chrome theme did not change'));
            }
            if (terminalBefore === terminalAfter) {
              return reject(new Error('live terminal palette did not change'));
            }
            if (!terminalBackgroundMatches()) {
              return reject(new Error('terminal host background diverged from its palette'));
            }
            if (!canvas.isConnected || document.querySelector('.terminal-container canvas') !== canvas) {
              return reject(new Error('theme switch remounted terminal'));
            }
            toggle.click();
            requestAnimationFrame(() => {
              if (document.documentElement.dataset.theme !== initial) {
                return reject(new Error('theme did not restore'));
              }
              resolve(initial + '→' + current + '→' + initial + ' · PTY canvas retained');
            });
          }));
        })
      `),
      'theme switch smoke timed out',
    )) as string
    console.log(`[smoke] synchronized theme switch OK (${themeStatus})`)

    const renderedLinkStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const link = (text) => [...document.querySelectorAll('.markdown-body a')]
            .find((node) => node.textContent?.trim() === text);
          let missingActivated = false;
          const renderedTab = [...document.querySelectorAll('.viewer-tab')]
            .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
          renderedTab?.querySelector('.tab-main')?.click();
          const waitForYaml = () => {
            const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent || '';
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
            const missing = missingActivated ? undefined : link('Missing target');
            if (missing && !missingActivated) {
              missingActivated = true;
              missing.click();
              return setTimeout(waitForContainedError, 50);
            }
            if (Date.now() > deadline) return reject(new Error(
              'missing internal link escaped the viewer: ' +
              (document.querySelector('.viewer-tab.active .tab-name')?.textContent || 'no title')
            ));
            setTimeout(waitForContainedError, 50);
          };
          waitForContainedError();
        })
      `),
      'rendered internal link did not stay in hvir',
      20_000,
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

    const viewerPositions = await withTimeout(
      verifyViewerPositions(
        win,
        viewerPositionPath,
        joinHostPath(smokeRoot, 'package.json'),
      ),
      'viewer mode position matrix timed out',
      25_000,
    )
    console.log(`[smoke] viewer mode positions OK (${viewerPositions})`)

    const jsonStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const open = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(largeJsonPath.path)});
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

    const largeFileStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const open = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(largeTextPath.path)});
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('large text fixture missing'));
              return setTimeout(open, 50);
            }
            const started = performance.now();
            file.click();
            requestAnimationFrame((painted) => {
              if (painted - started > 500) return reject(new Error('large-file activation stalled paint'));
              const waitForPreview = () => {
                const preview = document.querySelector('.large-file-preview');
                const meta = document.querySelector('.source-meta')?.textContent || '';
                if (preview && meta.includes('preview')) {
                  return resolve(meta + ' · activation paint ' + Math.round(painted - started) + 'ms');
                }
                if (Date.now() > deadline) return reject(new Error('bounded large-file preview timed out'));
                setTimeout(waitForPreview, 50);
              };
              waitForPreview();
            });
          };
          open();
        })
      `),
      'large text preview smoke timed out',
      20_000,
    )) as string
    console.log(`[smoke] bounded large-file view OK (${largeFileStatus})`)

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
              .find((node) => node.getAttribute('title') === ${JSON.stringify(liveReloadPath.path)});
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
              const source = [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.textContent?.trim() === 'source');
              source?.click();
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

    const diffBases = await withTimeout(
      verifyGitDiffBehavior(win, liveReloadPath),
      'single-file git diff modes did not render',
      20_000,
    )
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
            if (!changed.querySelector('.git-file-name .tree-file-stem')) {
              return reject(new Error('Git change filename does not match Files schema'));
            }
            const branchPoint = document.querySelector('.git-group.branch-point .git-group-toggle');
            if (branchPoint && branchPoint.getAttribute('aria-expanded') !== 'false') {
              return reject(new Error('Branch point is not collapsed by default'));
            }
            const branchSelect = document.querySelector('#git-branch-select');
            if (branchSelect && branchSelect.options.length > 1 && branchSelect.disabled) {
              return reject(new Error('Branch menu cannot be inspected while switching is blocked'));
            }
            const syncButtons = [...document.querySelectorAll('.git-sync-actions button')]
              .map((node) => node.textContent?.trim());
            if (!syncButtons.includes('Fetch') || !syncButtons.includes('Pull') ||
                !document.querySelector('.git-sync-summary')) {
              return reject(new Error('Git sync status/actions missing'));
            }
            const changedPath = changed.getAttribute('title') || '';
            const untracked = changed.querySelector('small')?.textContent?.trim().startsWith('?');
            changed.click();
            const waitForView = () => {
              const activePath = document.querySelector('.viewer-tab.active .tab-main')
                ?.getAttribute('title') || '';
              const activeMode = [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.getAttribute('aria-pressed') === 'true')
                ?.textContent?.trim();
              const expectedMode = untracked ? activeMode !== 'diff' : activeMode === 'diff';
              if (activePath !== changedPath || !activeMode || !expectedMode) {
                if (Date.now() <= deadline) return setTimeout(waitForView, 50);
                return reject(new Error(
                  'Git file did not settle: target=' + changedPath +
                    ' active=' + activePath +
                    ' mode=' + activeMode +
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
              .find((node) => node.getAttribute('title')?.endsWith('/package-lock.json'));
            if (!tracked) {
              if (Date.now() > deadline) return reject(new Error('tracked blame fixture missing'));
              return setTimeout(openTracked, 50);
            }
            tracked.click();
            const activateTracked = () => {
              const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent || '';
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
          const railButtons = [...document.querySelectorAll('.rail-nav button')];
          const byLabel = (label) =>
            railButtons.find((node) => node.textContent?.trim().startsWith(label));
          const files = byLabel('Files');
          const git = byLabel('Git');
          const harness = byLabel('Harness');
          const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
            .find((node) => node.querySelector(':scope > .directory-row')
              ?.getAttribute('title')?.endsWith('/src'));
          const smokeFile = [...document.querySelectorAll('[aria-label="Files"] .file-row')]
            .find((node) => node.getAttribute('title')
              ?.startsWith(${JSON.stringify(liveReloadPath.path)}));
          const rootStatus = document.querySelector(
            '[aria-label="Files"] .directory-row .tree-git-status.directory'
          );
          if (!files || !git || !harness || !directory) {
            return reject(new Error('stable rail navigation controls missing'));
          }
          if (!smokeFile?.querySelector('.tree-git-status.file.untracked') || !rootStatus) {
            return reject(new Error('working-tree explorer decorations missing'));
          }
          const directoryRow = directory.querySelector(':scope > .directory-row');
          if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
          const tabsBefore = document.querySelectorAll('.viewer-tab').length;
          harness.click();
          requestAnimationFrame(() => {
            const placeholder = document.querySelector('.harness-placeholder');
            if (
              harness.disabled ||
              !harness.classList.contains('active') ||
              harness.getAttribute('aria-current') !== 'page' ||
              !placeholder ||
              placeholder.hidden ||
              !placeholder.textContent?.includes('Coming soon')
            ) {
              return reject(new Error('Harness coming-soon route is not interactive'));
            }
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
              if (!files.classList.contains('active') || harness.disabled) {
                return reject(new Error('rail active states are incorrect'));
              }
              resolve(
                'stable tabs · Files state preserved · Git decorations · Harness coming soon'
              );
            });
          });
        })
      `),
      'rail navigation did not preserve section state',
    )) as string
    console.log(`[smoke] rail navigation OK (${railNavigationStatus})`)

    emit('project:state', smokeProjectState(host.connectionState, true))
    const missingWorkspaceStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const inspect = () => {
            const notices = [...document.querySelectorAll('.workspace-missing-notice')];
            const git = [...document.querySelectorAll('.rail-nav button')]
              .find((button) => button.textContent?.trim().startsWith('Git'));
            const terminal = document.querySelector('.terminal-surface');
            const newTerminal = document.querySelector('[aria-label="New terminal"]');
            const splitTerminal = document.querySelector('[aria-label="Split terminal"]');
            if (
              notices.length >= 2 && !git && terminal &&
              newTerminal?.disabled && splitTerminal?.disabled
            ) {
              const rawError = notices.some((notice) => notice.textContent?.includes('ENOENT'));
              if (rawError) return reject(new Error('missing workspace exposes a raw filesystem error'));
              return resolve(
                notices.length + ' notices · Git/new PTYs suppressed · terminal retained'
              );
            }
            if (Date.now() > deadline) {
              return reject(new Error('missing workspace state did not settle'));
            }
            setTimeout(inspect, 25);
          };
          inspect();
        })
      `),
      'missing workspace state timed out',
    )) as string
    console.log(`[smoke] missing workspace state OK (${missingWorkspaceStatus})`)
    emit('project:state', smokeProjectState())
    await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const inspect = () => {
            if (!document.querySelector('.workspace-missing-notice')) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('workspace did not recover'));
            setTimeout(inspect, 25);
          };
          inspect();
        })
      `),
      'workspace recovery timed out',
    )

    emit('project:state', smokeRemoteProjectState())
    const remoteConnectionStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const inspect = () => {
            const trigger = document.querySelector('.project-tab.active .project-connection-trigger');
            if (!(trigger instanceof HTMLButtonElement)) {
              if (Date.now() > deadline) return reject(new Error('active SSH connection control missing'));
              return setTimeout(inspect, 25);
            }
            trigger.click();
            const waitForMenu = () => {
              const menu = document.querySelector('.project-connection-menu');
              const text = menu?.textContent || '';
              if (
                menu && text.includes('ssh:smoke-remote') && text.includes('Connected') &&
                text.includes('File watching: polling') && text.includes('Change') &&
                text.includes('Disconnect')
              ) {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                const waitForClose = () => {
                  if (!document.querySelector('.project-connection-menu')) {
                    return resolve('badge→status + controls→Escape');
                  }
                  if (Date.now() > deadline) {
                    return reject(new Error('SSH connection menu ignored Escape'));
                  }
                  setTimeout(waitForClose, 25);
                };
                return waitForClose();
              }
              if (Date.now() > deadline) {
                return reject(new Error('SSH connection menu content is incomplete: ' + text));
              }
              setTimeout(waitForMenu, 25);
            };
            waitForMenu();
          };
          inspect();
        })
      `),
      'SSH connection controls timed out',
    )) as string
    console.log(`[smoke] SSH connection controls OK (${remoteConnectionStatus})`)
    emit('project:state', smokeProjectState())
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const active = document.querySelector('.project-tab.active');
          if (active && !active.querySelector('.remote-connection-badge')) return resolve(true);
          if (Date.now() > deadline) return reject(new Error('local project did not reactivate'));
          setTimeout(poll, 25);
        };
        poll();
      })
    `)
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })

    const sessionFlowStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        if (document.querySelector('.session-bar')) {
          return reject(new Error('legacy host/session strip is still mounted'));
        }
        const activeProject = document.querySelector('.project-tab.active');
        if (activeProject?.querySelector('.remote-connection-badge')) {
          return reject(new Error('local project shows a remote connection badge'));
        }
        const projectMain = activeProject?.querySelector('.project-tab-main');
        const viewerMain = document.querySelector('.viewer-tab.active .tab-main');
        const focusedBefore = document.activeElement;
        projectMain?.focus({ focusVisible: true });
        if (!projectMain || getComputedStyle(projectMain).boxShadow === 'none') {
          return reject(new Error(
            'project tab focus ring is missing: before=' + focusedBefore?.className +
            ' active=' + document.activeElement?.className +
            ' focusVisible=' + projectMain?.matches(':focus-visible')
          ));
        }
        viewerMain?.focus({ focusVisible: true });
        if (!viewerMain || getComputedStyle(viewerMain).boxShadow === 'none') {
          return reject(new Error('viewer tab focus ring is missing'));
        }
        if (document.querySelector('.workspaces-bar')) {
          return reject(new Error('single-checkout project should hide the workspaces bar'));
        }
        const addProject = document.querySelector('.project-add');
        if (!(addProject instanceof HTMLButtonElement)) {
          return reject(new Error('project registration control is missing'));
        }
        addProject.click();
        const waitForHost = () => {
          const local = [...document.querySelectorAll('.session-host-option')]
            .find((node) => node.textContent?.includes('Local'));
          const choose = [...document.querySelectorAll('.project-dialog button')]
            .find((node) => node.textContent?.trim() === 'Choose folder');
          if (!local || !choose) {
            if (Date.now() > deadline) return reject(new Error('session host step missing'));
            return setTimeout(waitForHost, 50);
          }
          if (local.querySelector('.remote-connection-badge')) {
            return reject(new Error('local host option shows a remote connection badge'));
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
          const workbench = document.querySelector('.workbench');
          const viewer = document.querySelector('.viewer-panel');
          const terminal = document.querySelector('.terminal-panel');
          const terminalRail = document.querySelector('.terminal-rail');
          const terminalControls = document.querySelector('.terminal-mode-controls');
          const treeDivider = document.querySelector('.tree-resizer');
          const terminalDivider = document.querySelector('.terminal-resizer');
          const treeToggle = document.querySelector('.tree-collapse-toggle');
          const terminalToggle = document.querySelector('.terminal-focus-toggle');
          const terminalCollapse = document.querySelector('.terminal-collapse-toggle');
          if (
            !tree || !workbench || !viewer || !terminal || !terminalRail ||
            !treeDivider || !terminalDivider || !treeToggle || !terminalToggle ||
            !terminalCollapse || !terminalControls
          ) {
            return reject(new Error('pane dividers missing'));
          }
          const workbenchRect = workbench.getBoundingClientRect();
          const viewerRect = viewer.getBoundingClientRect();
          const terminalRect = terminal.getBoundingClientRect();
          const terminalRailRect = terminalRail.getBoundingClientRect();
          const terminalDividerRect = terminalDivider.getBoundingClientRect();
          if (
            Math.abs(viewerRect.right - workbenchRect.right) > 1 ||
            Math.abs(terminalDividerRect.right - workbenchRect.right) > 1 ||
            Math.abs(terminalRailRect.top - terminalRect.top) > 1 ||
            Math.abs(terminalRailRect.bottom - terminalRect.bottom) > 1
          ) {
            return reject(new Error('terminal rail is not aligned to the terminal row'));
          }
          const treeBefore = tree.getBoundingClientRect().width;
          const terminalBefore = terminal.getBoundingClientRect().height;
          const defaultTerminalShare = 3.8 / (4 + 3.8);
          const requiredTerminalHeight = Math.min(
            325,
            Math.max(
              260,
              Math.floor(
                (workbenchRect.height - terminalDividerRect.height) *
                  defaultTerminalShare -
                  2
              )
            )
          );
          if (terminalBefore + 1 < requiredTerminalHeight) {
            return reject(new Error(
              'default terminal is too short: ' + Math.round(terminalBefore) +
              'px < ' + requiredTerminalHeight + 'px for a ' +
              Math.round(workbenchRect.height) + 'px workbench'
            ));
          }
          treeDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          terminalDivider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const treeAfter = tree.getBoundingClientRect().width;
            const terminalAfter = terminal.getBoundingClientRect().height;
            if (treeAfter <= treeBefore || terminalAfter <= terminalBefore) {
              return reject(new Error('pane keyboard resize did not change tracks'));
            }
            for (let index = 0; index < 32; index += 1) {
              terminalDivider.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowUp', bubbles: true
              }));
            }
            const terminalAtLimit = terminal.getBoundingClientRect();
            const workbenchAtLimit = workbench.getBoundingClientRect();
            if (terminalAtLimit.bottom > workbenchAtLimit.bottom + 1) {
              return reject(new Error(
                'terminal resize escaped the viewport: terminal=' + terminalAtLimit.bottom +
                ' workbench=' + workbenchAtLimit.bottom
              ));
            }
            treeDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            terminalDivider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const restoredTreeWidth = tree.getBoundingClientRect().width;
              treeToggle.click();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (
                  !workbench.classList.contains('tree-collapsed') ||
                  tree.getBoundingClientRect().width > 1 ||
                  getComputedStyle(tree).visibility !== 'hidden'
                ) {
                  return reject(new Error('file explorer did not collapse'));
                }
                terminalToggle.click();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  if (
                    !workbench.classList.contains('tree-collapsed') ||
                    !workbench.classList.contains('terminal-focused') ||
                    getComputedStyle(viewer).visibility !== 'hidden'
                  ) {
                    return reject(new Error('pane focus modes did not compose'));
                  }
                  terminalCollapse.click();
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const controlsRect = terminalControls.getBoundingClientRect();
                    const collapsedWorkbenchRect = workbench.getBoundingClientRect();
                    if (
                      workbench.classList.contains('terminal-focused') ||
                      !workbench.classList.contains('terminal-collapsed') ||
                      getComputedStyle(viewer).visibility === 'hidden' ||
                      getComputedStyle(terminalRail).visibility !== 'hidden' ||
                      controlsRect.bottom > collapsedWorkbenchRect.bottom + 1
                    ) {
                      return reject(new Error('terminal did not collapse from maximized state'));
                    }
                    terminalToggle.click();
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                      if (
                        !workbench.classList.contains('terminal-focused') ||
                        workbench.classList.contains('terminal-collapsed')
                      ) {
                        return reject(new Error('terminal did not maximize from collapsed state'));
                      }
                      terminalToggle.click();
                      treeToggle.click();
                      requestAnimationFrame(() => requestAnimationFrame(() => {
                        const finalTreeWidth = tree.getBoundingClientRect().width;
                        if (
                          workbench.classList.contains('tree-collapsed') ||
                          workbench.classList.contains('terminal-focused') ||
                          workbench.classList.contains('terminal-collapsed') ||
                          Math.abs(finalTreeWidth - restoredTreeWidth) > 1 ||
                          getComputedStyle(tree).visibility === 'hidden'
                        ) {
                          return reject(new Error('pane focus modes did not restore'));
                        }
                        resolve(
                          Math.round(treeBefore) + '→' + Math.round(treeAfter) + 'px tree; ' +
                          Math.round(terminalBefore) + '→' + Math.round(terminalAfter) +
                          'px terminal; three-state controls composed and restored'
                        );
                      }));
                    }));
                  }));
                }));
              }));
            }));
          }));
        })
      `),
      'pane resize controls did not respond',
    )) as string
    console.log(`[smoke] pane dividers OK (${resizeStatus})`)

    const resizerActionStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const frames = () => new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done))
          );
          const pointer = (target, type, id, x, y) => target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: id,
              isPrimary: true,
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: x,
              clientY: y
            })
          );
          const run = async () => {
            const workbench = document.querySelector('.workbench');
            const terminal = document.querySelector('.terminal-panel');
            const terminalDivider = document.querySelector('.terminal-resizer');
            const terminalToggle = document.querySelector('.terminal-focus-toggle');
            const tree = document.querySelector('.tree-panel');
            const treeToggle = document.querySelector('.tree-collapse-toggle');
            if (
              !workbench || !terminal || !terminalDivider || !terminalToggle ||
              !tree || !treeToggle
            ) {
              throw new Error('resizer action controls missing');
            }

            terminalToggle.click();
            await frames();
            if (!workbench.classList.contains('terminal-focused')) {
              throw new Error('terminal did not maximize before action drag');
            }
            const terminalButtonRect = terminalToggle.getBoundingClientRect();
            const workbenchRect = workbench.getBoundingClientRect();
            const terminalTargetY = workbenchRect.bottom - 280;
            const terminalStartX = terminalButtonRect.left + terminalButtonRect.width / 2;
            const terminalStartY = terminalButtonRect.top + terminalButtonRect.height / 2;
            pointer(terminalToggle, 'pointerdown', 41, terminalStartX, terminalStartY);
            pointer(terminalToggle, 'pointermove', 41, terminalStartX, terminalTargetY);
            pointer(terminalToggle, 'pointerup', 41, terminalStartX, terminalTargetY);
            terminalToggle.click();
            await frames();
            const terminalHeight = terminal.getBoundingClientRect().height;
            if (
              workbench.classList.contains('terminal-focused') ||
              workbench.classList.contains('terminal-collapsed') ||
              Math.abs(terminalHeight - 280) > 2
            ) {
              throw new Error(
                'terminal action drag toggled instead of resizing: ' + terminalHeight
              );
            }

            treeToggle.click();
            await frames();
            if (!workbench.classList.contains('tree-collapsed')) {
              throw new Error('tree did not collapse before action drag');
            }
            const treeButtonRect = treeToggle.getBoundingClientRect();
            const treeTargetX = workbenchRect.left + 260;
            const treeStartX = treeButtonRect.left + treeButtonRect.width / 2;
            const treeStartY = treeButtonRect.top + treeButtonRect.height / 2;
            pointer(treeToggle, 'pointerdown', 42, treeStartX, treeStartY);
            pointer(treeToggle, 'pointermove', 42, treeTargetX, treeStartY);
            pointer(treeToggle, 'pointerup', 42, treeTargetX, treeStartY);
            treeToggle.click();
            await frames();
            const treeWidth = tree.getBoundingClientRect().width;
            if (
              workbench.classList.contains('tree-collapsed') ||
              Math.abs(treeWidth - 260) > 2 ||
              document.body.classList.contains('pane-resizing')
            ) {
              throw new Error('tree action drag toggled instead of resizing: ' + treeWidth);
            }
            resolve(
              Math.round(terminalHeight) + 'px terminal; ' +
              Math.round(treeWidth) + 'px tree; action drags suppressed clicks'
            );
          };
          void run().catch(reject);
        })
      `),
      'pane action drag smoke timed out',
    )) as string
    console.log(`[smoke] pane action drags OK (${resizerActionStatus})`)

    const splitStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          document.querySelector('[aria-label="Close secondary viewer"]')?.click();
          const begin = () => {
            const split = document.querySelector('[aria-label="Split viewer right"]');
            const sourceTab = document.querySelector('.viewer-group-primary .viewer-tab');
            if (!split || !sourceTab) {
              if (Date.now() > deadline) return reject(new Error('viewer split controls missing'));
              return setTimeout(begin, 50);
            }
            split.click();
            requestAnimationFrame(() => {
              const target = document.querySelector('.viewer-group-secondary .tab-strip');
              if (!target) return reject(new Error('secondary viewer did not open'));
              const transfer = new DataTransfer();
              sourceTab.dispatchEvent(new DragEvent('dragstart', {
                bubbles: true, dataTransfer: transfer
              }));
              target.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: transfer
              }));
              target.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: transfer
              }));
              const waitForViewer = () => {
                const secondaryTab = document.querySelector('.viewer-group-secondary .viewer-tab');
                const divider = document.querySelector('.viewer-split-resizer');
                if (secondaryTab && divider) {
                  if (divider.getBoundingClientRect().width > 1.5) {
                    return reject(new Error('viewer split divider is wider than its hairline'));
                  }
                  const before = document.querySelector('.viewer-group-primary')?.getBoundingClientRect().width || 0;
                  divider.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'ArrowRight', bubbles: true
                  }));
                  return requestAnimationFrame(() => {
                    const after = document.querySelector('.viewer-group-primary')?.getBoundingClientRect().width || 0;
                    if (after <= before) return reject(new Error('viewer split did not resize'));
                    secondaryTab.querySelector('.tab-close')?.click();
                    const waitForClose = () => {
                      if (!document.querySelector('.viewer-group-secondary') &&
                          document.querySelectorAll('.viewer-group-primary .viewer-tab').length > 0) {
                        return terminalSplit();
                      }
                      if (Date.now() > deadline) return reject(new Error('empty viewer split did not auto-collapse'));
                      setTimeout(waitForClose, 50);
                    };
                    waitForClose();
                  });
                }
                if (Date.now() > deadline) return reject(new Error('tab did not move between viewer panes'));
                setTimeout(waitForViewer, 50);
              };
              waitForViewer();
            });
          };
          const terminalSplit = () => {
            const button = document.querySelector('.terminal-split-button');
            const before = document.querySelectorAll('.terminal-list-row').length;
            if (!button) return reject(new Error('terminal split control missing'));
            button.click();
            const waitForTerminal = () => {
              const deck = document.querySelector('.terminal-deck:not([hidden])');
              const rows = [...document.querySelectorAll('.terminal-list-row')];
              const visible = deck?.querySelectorAll('.terminal-surface.visible canvas').length || 0;
              if (deck?.classList.contains('split') && rows.length === before + 1 && visible === 2) {
                const divider = deck.querySelector('.terminal-split-resizer');
                if (!divider) return reject(new Error('terminal split divider missing'));
                if (divider.getBoundingClientRect().width > 1.5) {
                  return reject(new Error('terminal split divider is wider than its hairline'));
                }
                const left = deck.querySelector('[data-terminal-slot="primary"].visible');
                const widthBefore = left?.getBoundingClientRect().width || 0;
                divider.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'ArrowRight', bubbles: true
                }));
                return requestAnimationFrame(() => {
                  const widthAfter = left?.getBoundingClientRect().width || 0;
                  if (widthAfter <= widthBefore) return reject(new Error('terminal split did not resize'));
                  rows.at(-1)?.querySelector('.terminal-close-button')?.click();
                  const waitForCollapse = () => {
                    if (!deck.classList.contains('split') &&
                        document.querySelectorAll('.terminal-list-row').length === before) {
                      return resolve('viewer drag/drop + terminal PTY split + keyboard dividers');
                    }
                    if (Date.now() > deadline) return reject(new Error('terminal split did not collapse'));
                    setTimeout(waitForCollapse, 50);
                  };
                  waitForCollapse();
                });
              }
              if (Date.now() > deadline) return reject(new Error('split terminal PTY did not become ready'));
              setTimeout(waitForTerminal, 50);
            };
            waitForTerminal();
          };
          begin();
        })
      `),
      'split layout smoke timed out',
      18_000,
    )) as string
    console.log(`[smoke] split panes OK (${splitStatus})`)

    const settingsStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          document.querySelector('.settings-toggle')?.click();
          requestAnimationFrame(() => {
            const dialog = document.querySelector('.settings-dialog');
            const sections = [...(dialog?.querySelectorAll(
              '.settings-section-index button'
            ) || [])];
            const appearance = dialog?.querySelector('#settings-appearance-title');
            if (!dialog || !appearance || sections.length !== 5) {
              return reject(new Error('settings surface incomplete'));
            }
            sections.find((button) => button.textContent?.trim() === 'Keybindings')?.click();
            requestAnimationFrame(() => {
            const keybindings = dialog.querySelector('.settings-keybindings textarea');
            if (!keybindings?.value.includes('toggleTerminalFocus')) {
              return reject(new Error('keybindings section did not activate'));
            }
            const terminalFocused = document.querySelector('.workbench')
              ?.classList.contains('terminal-focused');
            document.body.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'J', code: 'KeyJ', bubbles: true, shiftKey: true,
              metaKey: navigator.platform.includes('Mac'),
              ctrlKey: !navigator.platform.includes('Mac')
            }));
            keybindings.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', bubbles: true
            }));
            requestAnimationFrame(() => {
              const openDialog = document.querySelector('.settings-dialog');
              if (!openDialog || document.querySelector('.workbench')
                  ?.classList.contains('terminal-focused') !== terminalFocused) {
                return reject(new Error('settings modal leaked a global shortcut or textarea Escape'));
              }
              sections.find((button) => button.textContent?.trim() === 'Terminal')?.click();
              requestAnimationFrame(() => {
              const idle = openDialog.querySelector('#settings-idle-threshold');
              if (!idle) return reject(new Error('idle threshold control missing'));
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                ?.set?.call(idle, '');
              idle.dispatchEvent(new Event('input', { bubbles: true }));
              requestAnimationFrame(() => {
                [...openDialog.querySelectorAll('button')]
                  .find((button) => button.textContent?.trim() === 'Save app settings')?.click();
                requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const validation = document.querySelector('.settings-dialog .dialog-error')
                    ?.textContent || '';
                  if (!/idle threshold/i.test(validation)) {
                    return reject(new Error('blank idle threshold did not show validation'));
                  }
                  if (openDialog.querySelector('[aria-current="page"]')
                      ?.textContent?.trim() !== 'Terminal' || document.activeElement !== idle) {
                    return reject(new Error('settings validation did not target its section'));
                  }
                  [...openDialog.querySelectorAll('button')]
                    .find((button) => button.textContent?.trim() === 'Close settings')?.click();
                  requestAnimationFrame(() => {
                    if (document.querySelector('.settings-dialog')) {
                      return reject(new Error('settings dialog did not close'));
                    }
                    resolve('5 sections · modal isolation · validation focus');
                  });
                });
                });
              });
            });
            });
            });
          });
        })
      `),
      'settings smoke timed out',
    )) as string
    console.log(`[smoke] minimal settings OK (${settingsStatus})`)

    const harnessRenameStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          document.querySelector(
            '.terminal-icon-button[aria-label="New terminal"]'
          )?.click();
          const waitForProfile = () => {
            const rows = [...document.querySelectorAll('.settings-profile-list button')];
            const source = rows.find((row) =>
              row.querySelector('strong')?.textContent?.trim() === 'Smoke custom harness'
            );
            if (!source) {
              if (Date.now() > deadline) return reject(new Error('smoke harness profile missing'));
              return setTimeout(waitForProfile, 50);
            }
            const dialog = document.querySelector('.settings-dialog');
            const heading = document.querySelector('#settings-harnesses-title');
            const active = dialog?.querySelector('[aria-current="page"]')
              ?.textContent?.trim();
            if (!dialog || !heading || active !== 'Harnesses') {
              return reject(new Error('configure harnesses did not target its section'));
            }
            const beginProfileEdit = () => {
              source.click();
              requestAnimationFrame(() => {
              const before = document.querySelectorAll('.settings-profile-list button').length;
              const duplicate = [...document.querySelectorAll('.settings-profile-actions button')]
                .find((button) => button.textContent?.trim() === 'Duplicate');
              if (!duplicate) return reject(new Error('harness duplicate action missing'));
              duplicate.click();
              const waitForDuplicate = () => {
                const name = document.querySelector(
                  '.settings-profile-grid label:first-child input'
                );
                const count = document.querySelectorAll('.settings-profile-list button').length;
                if (count > before && name?.value === 'Smoke custom harness copy') {
                  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                    ?.set?.call(name, 'Smoke renamed harness');
                  name.dispatchEvent(new Event('input', { bubbles: true }));
                  return requestAnimationFrame(() => {
                    if (document.querySelector('.fatal-error')) {
                      return reject(new Error('harness rename escaped to the error boundary'));
                    }
                    if (name.value !== 'Smoke renamed harness') {
                      return reject(new Error('harness profile rename did not update'));
                    }
                    const argv = document.querySelector('.settings-profile-argv textarea');
                    if (!argv) return reject(new Error('harness argument editor missing'));
                    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
                      ?.set?.call(argv, '--add-dir {binding:workspace}');
                    argv.dispatchEvent(new Event('input', { bubbles: true }));
                    const waitForArgumentPreview = () => {
                      const help = document.querySelector('#harness-arguments-help')
                        ?.textContent || '';
                      const previews = [...document.querySelectorAll(
                        '.settings-profile-previews code'
                      )].map((node) => node.textContent || '');
                      if (/2 argv values/.test(help) &&
                          previews.some((value) => value.includes('--add-dir'))) {
                        [...document.querySelectorAll('.settings-dialog .dialog-actions button')]
                          .find((button) => button.textContent?.trim() === 'Close settings')
                          ?.click();
                        return requestAnimationFrame(() => {
                          const prompt = document.querySelector('.unsaved-harness-dialog');
                          if (!prompt) {
                            return reject(new Error('unsaved harness prompt did not open'));
                          }
                          [...prompt.querySelectorAll('button')]
                            .find((button) =>
                              button.textContent?.trim() === 'Save harness profile'
                            )?.click();
                          const waitForGuardedSave = () => {
                            if (!document.querySelector('.settings-dialog')) {
                              return resolve(
                                'section-targeted + duplicate-safe add + rename + same-line argv + guarded save'
                              );
                            }
                            if (Date.now() > deadline) {
                              return reject(new Error('guarded harness save did not close settings'));
                            }
                            setTimeout(waitForGuardedSave, 50);
                          };
                          waitForGuardedSave();
                        });
                      }
                      if (Date.now() > deadline) {
                        return reject(new Error('same-line arguments did not reach preview'));
                      }
                      setTimeout(waitForArgumentPreview, 50);
                    };
                    waitForArgumentPreview();
                  });
                }
                if (Date.now() > deadline) {
                  return reject(new Error('duplicated harness profile did not become editable'));
                }
                setTimeout(waitForDuplicate, 50);
              };
                waitForDuplicate();
              });
            };
            const addHarness = [...document.querySelectorAll(
              '.settings-harness-actions button'
            )].find((button) => button.textContent?.trim() === 'Add a harness…');
            if (!addHarness) return reject(new Error('add harness action missing'));
            addHarness.click();
            const waitForConfiguredTemplate = () => {
              const candidates = [...document.querySelectorAll(
                '.add-harness-candidates label'
              )];
              const candidate = candidates.find((label) =>
                (label.querySelector('small')?.textContent || '').includes('Already added')
              );
              if (candidate) {
                const checkbox = candidate.querySelector('input[type="checkbox"]');
                const detail = candidate.querySelector('small')?.textContent || '';
                if (!checkbox?.disabled || !detail.includes('Already added')) {
                  return reject(new Error('configured template remained selectable'));
                }
                [...document.querySelectorAll('.add-harness-dialog button')]
                  .find((button) => button.textContent?.trim() === 'Cancel')?.click();
                return requestAnimationFrame(beginProfileEdit);
              }
              const refresh = [...document.querySelectorAll('.add-harness-dialog button')]
                .find((button) => button.textContent?.trim() === 'Refresh');
              if (refresh && !refresh.disabled) {
                [...document.querySelectorAll('.add-harness-dialog button')]
                  .find((button) => button.textContent?.trim() === 'Cancel')?.click();
                return requestAnimationFrame(beginProfileEdit);
              }
              if (Date.now() > deadline) {
                return reject(new Error('configured template detection did not settle'));
              }
              setTimeout(waitForConfiguredTemplate, 50);
            };
            waitForConfiguredTemplate();
          };
          const waitForConfigure = () => {
            const configure = [...document.querySelectorAll('.terminal-new-menu button')]
              .find((button) => button.textContent?.trim() === 'Configure harnesses…');
            if (configure) {
              configure.click();
              return waitForProfile();
            }
            if (Date.now() > deadline) {
              return reject(new Error('configure harnesses action missing'));
            }
            requestAnimationFrame(waitForConfigure);
          };
          waitForConfigure();
        })
      `),
      'harness profile editor smoke timed out',
    )) as string
    console.log(`[smoke] harness profile editor OK (${harnessRenameStatus})`)

    const closeableState = smokeProjectState()
    smokeIpcProjectState = {
      ...closeableState,
      projects: [
        ...closeableState.projects,
        {
          id: 'smoke-closeable-project',
          registeredRoot: smokeCloseableRoot,
          displayName: 'Close me',
          connectionState: host.connectionState,
          watchTier: host.watchTier,
          activeWorkspaceId: 'smoke-closeable-workspace',
          workspaces: [
            {
              id: 'smoke-closeable-workspace',
              root: smokeCloseableRoot,
              name: 'Close me',
              main: true,
              missing: true,
              repository: false,
              changedFiles: 0,
            },
          ],
        },
      ],
    }
    emit('project:state', smokeIpcProjectState)
    const projectCloseStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const waitForClose = () => {
            const close = document.querySelector(
              '[aria-label="Close project Close me"]'
            );
            if (!close) {
              if (Date.now() > deadline) return reject(new Error('project close control missing'));
              return setTimeout(waitForClose, 25);
            }
            if (close.disabled) return reject(new Error('secondary project close is disabled'));
            close.click();
            requestAnimationFrame(() => {
              const dialog = document.querySelector('.close-project-dialog');
              if (!dialog || !dialog.textContent?.includes('Files, Git branches, and worktrees are not changed')) {
                return reject(new Error('project close confirmation incomplete'));
              }
              [...dialog.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === 'Close project')?.click();
              const waitForRemoval = () => {
                const removed = document.querySelector('[aria-label="Close project Close me"]');
                const remaining = document.querySelector('[aria-label="Close project hvir"]');
                if (!removed && remaining?.disabled) {
                  return resolve('confirmed unregister · final project protected');
                }
                if (Date.now() > deadline) return reject(new Error('project did not close safely'));
                setTimeout(waitForRemoval, 25);
              };
              waitForRemoval();
            });
          };
          waitForClose();
        })
      `),
      'project close smoke timed out',
    )) as string
    console.log(`[smoke] project close OK (${projectCloseStatus})`)

    const previousRecoveryMode = (await win.webContents.executeJavaScript(
      `localStorage.getItem('hvir:terminal-recovery-mode')`,
    )) as string | null
    const previousSettings = (await win.webContents.executeJavaScript(
      `localStorage.getItem('hvir:settings:v1')`,
    )) as string | null
    await win.webContents.executeJavaScript(
      `localStorage.setItem('hvir:terminal-recovery-mode', 'prompt'); localStorage.setItem('hvir:settings:v1', JSON.stringify({ terminalRecoveryMode: 'prompt' }))`,
    )
    smokeRecoverySessions = [
      {
        id: 'smoke-recovery-shell',
        providerId: defaultHarnessProviderId,
        profileId: asHarnessProfileId('plain-shell-default'),
        launchRevision: 1,
        hostId: smokeRoot.hostId,
        cwd: smokeRoot,
        title: 'Recovered smoke shell',
        position: 0,
        active: true,
        updatedAt: Date.now(),
      },
    ]
    const reloaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    win.webContents.reload()
    await withTimeout(reloaded, 'recovery smoke reload timed out')
    let recoveryStatus: string
    try {
      recoveryStatus = (await withTimeout(
        win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const deadline = Date.now() + 10000;
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
                      if (status.startsWith('pid ') && gitReady) {
                        return resolve('toggle selection · restore · ' + status);
                      }
                      if (Date.now() > deadline) {
                        return reject(new Error('restored workspace did not settle: ' + status));
                      }
                      setTimeout(waitForTerminal, 25);
                    };
                    waitForTerminal();
                  });
                });
                return;
              }
              if (Date.now() > deadline) return reject(new Error('recovery dialog missing'));
              setTimeout(waitForDialog, 25);
            };
            waitForDialog();
          })
        `),
        'terminal recovery interaction timed out',
        12_000,
      )) as string
    } finally {
      if (previousRecoveryMode === null) {
        await win.webContents.executeJavaScript(
          `localStorage.removeItem('hvir:terminal-recovery-mode')`,
        )
      } else {
        await win.webContents.executeJavaScript(
          `localStorage.setItem('hvir:terminal-recovery-mode', ${JSON.stringify(previousRecoveryMode)})`,
        )
      }
      if (previousSettings === null) {
        await win.webContents.executeJavaScript(
          `localStorage.removeItem('hvir:settings:v1')`,
        )
      } else {
        await win.webContents.executeJavaScript(
          `localStorage.setItem('hvir:settings:v1', ${JSON.stringify(previousSettings)})`,
        )
      }
    }
    console.log(`[smoke] terminal recovery picker OK (${recoveryStatus})`)
    await verifyRendererLifecycleCleanup({
      win,
      initialGeneration: initialRendererGeneration,
      resources: rendererResources,
      routes: webPaneRoutes,
      supervisor,
      root: smokeRoot,
      host,
    })
    console.log(
      '[smoke] renderer generation reload + webContents destruction owner cleanup OK',
    )
    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    await cleanup.run()
  }
}

interface CapacitySmokeReport {
  readonly durationMs: number
  readonly frameGapsMs: readonly number[]
  readonly clickLatenciesMs: readonly number[]
  readonly p99Ms: number
  readonly maxMs: number
  readonly memoryStartKiB?: number
  readonly memoryEndKiB?: number
  readonly memoryPeakKiB?: number
  readonly memoryGrowthKiB?: number
}

async function runCapacityRecoverySmoke(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await win.webContents.executeJavaScript(
    `localStorage.setItem('hvir:terminal-recovery-mode', 'prompt')`,
  )
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )
  win.webContents.reload()
  await withTimeout(loaded, 'capacity recovery reload timed out')
  const status = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const waitForDialog = () => {
          const dialog = document.querySelector('.terminal-recovery-dialog');
          const restore = [...(dialog?.querySelectorAll('button') || [])]
            .find((node) => node.textContent?.trim() === 'Restore selected');
          if (restore) {
            restore.click();
            return waitForTerminals();
          }
          if (Date.now() > deadline) return reject(new Error('capacity recovery dialog missing'));
          setTimeout(waitForDialog, 25);
        };
        const waitForTerminals = () => {
          const rows = [...document.querySelectorAll('.terminal-list-row')];
          const surfaces = [...document.querySelectorAll('.terminal-surface')];
          const activeStatus = document.querySelector('.terminal-surface.active')
            ?.getAttribute('data-terminal-status') || '';
          if (rows.length === 12 && surfaces.length === 12 && activeStatus.startsWith('pid ')) {
            const git = document.querySelector('.rail-nav button:nth-child(2)');
            git?.click();
            const waitForGit = () => {
              const changes = [...document.querySelectorAll('.git-tabs button')]
                .some((node) => /^Changes \\(\\d+\\)$/.test(node.textContent?.trim() || ''));
              if (git?.classList.contains('active') && changes) {
                const history = [...document.querySelectorAll('.git-tabs button')]
                  .find((node) => node.textContent?.trim() === 'History');
                history?.click();
                const waitForHistory = () => {
                  if (document.querySelector('.git-rail-history-row.commit')) {
                    return resolve(
                      '12 restored terminals · ' + activeStatus + ' · Changes + History ready'
                    );
                  }
                  if (Date.now() > deadline) return reject(new Error('Git History unavailable after capacity restore'));
                  setTimeout(waitForHistory, 25);
                };
                return waitForHistory();
              }
              if (Date.now() > deadline) return reject(new Error('Git unavailable after capacity restore'));
              setTimeout(waitForGit, 25);
            };
            return waitForGit();
          }
          if (Date.now() > deadline) return reject(new Error(
            'capacity terminals did not restore: rows=' + rows.length +
            ' surfaces=' + surfaces.length + ' status=' + activeStatus
          ));
          setTimeout(waitForTerminals, 25);
        };
        waitForDialog();
      })
    `),
    'capacity recovery interaction timed out',
    25_000,
  )) as string
  if (supervisor.list().length !== 12) {
    throw new Error(
      `capacity recovery expected 12 supervised terminals, found ${supervisor.list().length}`,
    )
  }
  console.log(`[smoke] multi-terminal recovery under load OK (${status})`)
}

async function runCapacityLoadSmoke(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  churnPath: HostPath,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const waitFor = (predicate, message, timeoutMs = 10000) =>
          new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const poll = () => {
              const value = predicate();
              if (value) return resolve(value);
              if (Date.now() > deadline) return reject(new Error(message));
              setTimeout(poll, 25);
            };
            poll();
          });
        for (let target = document.querySelectorAll('.terminal-list-row').length + 1;
          target <= 12;
          target++) {
          const add = await waitFor(
            () => document.querySelector('button[aria-label="New terminal"]:not(:disabled)'),
            'new-terminal button unavailable'
          );
          add.click();
          const shell = await waitFor(
            () => [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell'),
            'shell menu item unavailable'
          );
          shell.click();
          await waitFor(() => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const activeStatus = document.querySelector('.terminal-surface.active')
              ?.getAttribute('data-terminal-status') || '';
            return rows.length === target && activeStatus.startsWith('pid ');
          }, 'terminal ' + target + ' did not settle');
        }
        return document.querySelectorAll('.terminal-list-row').length;
      })()
    `),
    'capacity terminal setup timed out',
    30_000,
  )
  if (supervisor.list().length !== 12) {
    throw new Error(
      `capacity smoke expected 12 terminals, found ${supervisor.list().length}`,
    )
  }

  for (const terminal of supervisor.list()) {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      'i=0; while [ "$i" -lt 320 ]; do printf \'hvir-load-%04d abcdefghijklmnopqrstuvwxyz\\n\' "$i"; i=$((i+1)); sleep 0.1; done\n',
    )
  }
  let churning = true
  const watchChurn = (async (): Promise<void> => {
    let generation = 0
    while (churning) {
      await host.writeFile(churnPath, `capacity churn ${generation++}\n`)
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  })()

  let report: CapacitySmokeReport
  const memoryStartKiB = appWorkingSetKiB()
  let memoryPeakKiB = memoryStartKiB
  const memoryTimer = setInterval(() => {
    memoryPeakKiB = Math.max(memoryPeakKiB, appWorkingSetKiB())
  }, 500)
  try {
    report = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const durationMs = 30000;
          const started = performance.now();
          const frameGapsMs = [];
          const clickLatenciesMs = [];
          let previousFrame;
          let clickPending = false;
          let clickTimer;
          const percentile = (values, fraction) => {
            if (!values.length) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
          };
          const measureClick = () => {
            if (clickPending) return;
            const buttons = [...document.querySelectorAll('.rail-nav button:not(:disabled)')];
            const current = buttons.find((button) => button.classList.contains('active'));
            const target = buttons.find((button) => button !== current);
            if (!target) return;
            clickPending = true;
            const clickStarted = performance.now();
            target.click();
            const waitForState = (now) => {
              if (target.classList.contains('active')) {
                clickLatenciesMs.push(Math.max(0, now - clickStarted));
                clickPending = false;
              } else if (now - clickStarted > 1000) {
                reject(new Error('rail click did not reach visible state within 1s'));
              } else {
                requestAnimationFrame(waitForState);
              }
            };
            requestAnimationFrame(waitForState);
          };
          clickTimer = setInterval(measureClick, 400);
          const frame = (now) => {
            if (previousFrame !== undefined) frameGapsMs.push(now - previousFrame);
            previousFrame = now;
            if (now - started < durationMs) {
              requestAnimationFrame(frame);
              return;
            }
            clearInterval(clickTimer);
            const finish = () => {
              const samples = [...frameGapsMs, ...clickLatenciesMs];
              const rounded = (values) => values.map((value) => Math.round(value * 10) / 10);
              resolve({
                durationMs: now - started,
                frameGapsMs: rounded(frameGapsMs),
                clickLatenciesMs: rounded(clickLatenciesMs),
                p99Ms: Math.round(percentile(samples, 0.99) * 10) / 10,
                maxMs: Math.round(Math.max(0, ...samples) * 10) / 10,
              });
            };
            if (clickPending) requestAnimationFrame(finish);
            else finish();
          };
          requestAnimationFrame(frame);
        })
      `),
      '30-second renderer responsiveness probe timed out',
      40_000,
    )) as CapacitySmokeReport
  } finally {
    clearInterval(memoryTimer)
    churning = false
    await watchChurn
    for (const terminal of supervisor.list()) {
      supervisor.write(terminal.id, terminal.ownerId, '\u0003')
    }
  }

  const memoryEndKiB = appWorkingSetKiB()
  report = {
    ...report,
    memoryStartKiB,
    memoryEndKiB,
    memoryPeakKiB,
    memoryGrowthKiB: memoryEndKiB - memoryStartKiB,
  }

  console.log(`[smoke:capacity:raw] ${JSON.stringify(report)}`)
  if (report.p99Ms >= 100) {
    throw new Error(`capacity responsiveness p99 ${report.p99Ms}ms exceeded 100ms`)
  }
  if (report.maxMs > 500) {
    throw new Error(`capacity responsiveness max ${report.maxMs}ms exceeded 500ms`)
  }
  if ((report.memoryGrowthKiB ?? 0) > 256 * 1024) {
    throw new Error(
      `capacity memory grew ${Math.round((report.memoryGrowthKiB ?? 0) / 1024)} MiB in 30s`,
    )
  }
  console.log(
    `[smoke] 12-terminal responsiveness OK (p99 ${report.p99Ms}ms · max ${report.maxMs}ms · ${report.clickLatenciesMs.length} clicks · memory ${Math.round((report.memoryGrowthKiB ?? 0) / 1024)} MiB net / ${Math.round(((report.memoryPeakKiB ?? 0) - (report.memoryStartKiB ?? 0)) / 1024)} MiB peak growth)`,
  )
}

function appWorkingSetKiB(): number {
  return app
    .getAppMetrics()
    .reduce((total, metric) => total + metric.memory.workingSetSize, 0)
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

async function smokeWaitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
