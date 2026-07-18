/** Electron main-process entry and current application composition root. */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  session,
  shell,
  webContents,
  type Session,
  type WebContents,
} from 'electron'

import { registerIpcHandlers } from './ipc'
import { dispatchWorkerHostCall } from './git/worker-host-broker'
import { GIT_FETCH_ARGS, GIT_PULL_ARGS } from './git/git-engine'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import {
  WEB_PANE_PARTITION_PREFIX,
  WebPaneRouteRegistry,
} from './web-pane/web-pane-route-registry'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import type { ProjectHost } from './project-host'
import { ProjectRegistry, RendererSshPrompter } from './project-registry'
import { PtySupervisor } from './pty/pty-supervisor'
import { isSafeExternalUrl, isWorkbenchDocument } from './navigation-policy'
import { AttentionBadge } from './attention-badge'
import { HarnessProfileStore } from './harness/harness-profile-store'
import { HarnessProbeManager } from './harness/harness-probe'
import {
  canonicalProjectWatchInterests,
  ProjectWatchController,
  type ProjectWatchInterestCache,
} from './project-watch'
import { TerminalSessionRegistry } from './terminal/session-registry'
import {
  DEFAULT_KEYBINDINGS,
  GIT_CHANGED_FILE_COUNT_TYPE,
  GIT_PRUNE_WORKTREES_TYPE,
  GIT_WORKTREES_TYPE,
  GIT_FETCH_TYPE,
  GIT_PULL_TYPE,
  GIT_SWITCH_BRANCH_TYPE,
  MAX_PROJECT_WATCH_INTERESTS,
  hostPathEquals,
  matchesKeybinding,
  localPath,
  LOCAL_HOST_ID,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  type KeybindingAction,
  type KeybindingMap,
  type ProjectState,
  type WebPaneCommandAction,
  type WorktreeDiscovery,
  HTML_PREVIEW_SCHEME,
} from '../shared'

protocol.registerSchemesAsPrivileged([
  {
    scheme: HTML_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, bypassCSP: false },
  },
])

const htmlPreviews = new HtmlPreviewProtocol()
const webPaneSessionPartitions = new WeakMap<Session, string>()
const webPaneBindings = new Map<number, KeybindingMap>()
const fullPageWebPanes = new Map<number, string>()
const webPaneRoutes = new WebPaneRouteRegistry({
  prepareSession: prepareWebPaneSession,
  destroyGuest: (guestId) => {
    const guest = webContents.fromId(guestId)
    if (guest && !guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
  },
  emitDiagnostic: (ownerId, paneId, event) => {
    const owner = webContents.fromId(ownerId)
    if (owner && !owner.isDestroyed()) {
      owner.send('web-pane:diagnostic', { paneId, event })
    }
  },
})

function closeWebPanes(
  scope: 'all' | { readonly ownerId: number } | { readonly root: HostPath },
): void {
  const closing =
    scope === 'all'
      ? webPaneRoutes.closeAll()
      : 'ownerId' in scope
        ? webPaneRoutes.closeOwner(scope.ownerId)
        : webPaneRoutes.closeWorkspace(scope.root)
  void closing.catch((error) => console.error('[web-pane] cleanup failed', error))
}
const harnessProbeManager = new HarnessProbeManager()

let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
let gitWorker: WorkerClient<GitWorkerProtocol> | null = null
let projectRegistry: ProjectRegistry | null = null
let sshPrompter: RendererSshPrompter | null = null
let ptySupervisor: PtySupervisor | null = null
let terminalSessionRegistry: TerminalSessionRegistry | null = null
let harnessProfileStore: HarnessProfileStore | null = null
let attentionBadge: AttentionBadge | null = null
let projectWatchController: ProjectWatchController | null = null
let projectWatchInterestCache: ProjectWatchInterestCache = new Map()
let projectWatchInterestGeneration = 0
let workspacePoll: ReturnType<typeof setInterval> | null = null
const workspaceRefreshes = new Map<string, Promise<ProjectState>>()
const workspaceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const workspacePrunes = new Map<string, Promise<ProjectState>>()
const worktreePruneAuthorizations = new Set<string>()
const branchSwitchAuthorizations = new Set<string>()
const gitFetchAuthorizations = new Set<string>()
const gitPullAuthorizations = new Set<string>()
let sessionOperation: Promise<void> = Promise.resolve()
let suspendSessions: Promise<void> = Promise.resolve()
let shutdownStarted = false
let shutdownComplete = false

async function prepareWebPaneSession({
  partition,
  proxyPort,
  primaryUrl,
}: {
  readonly partition: string
  readonly proxyPort: number
  readonly primaryUrl: string
}): Promise<() => Promise<void>> {
  const paneSession = session.fromPartition(partition, { cache: true })
  webPaneSessionPartitions.set(paneSession, partition)
  paneSession.setPermissionCheckHandler(() => false)
  paneSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  paneSession.setDevicePermissionHandler(() => false)
  paneSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  const denyDownload = (event: Electron.Event): void => event.preventDefault()
  paneSession.on('will-download', denyDownload)
  await paneSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: `http://127.0.0.1:${proxyPort}`,
    proxyBypassRules: '<-loopback>',
  })
  await paneSession.forceReloadProxyConfig()
  const resolvedProxy = await paneSession.resolveProxy(primaryUrl)
  if (
    !resolvedProxy
      .split(';')
      .some((rule) => rule.trim() === `PROXY 127.0.0.1:${proxyPort}`)
  ) {
    paneSession.off('will-download', denyDownload)
    await paneSession.setProxy({ mode: 'direct' })
    throw new Error(`Chromium did not select the pane proxy (${resolvedProxy})`)
  }
  return async () => {
    paneSession.off('will-download', denyDownload)
    paneSession.setPermissionCheckHandler(null)
    paneSession.setPermissionRequestHandler(null)
    paneSession.setDevicePermissionHandler(null)
    paneSession.setDisplayMediaRequestHandler(null)
    await paneSession.closeAllConnections()
    await paneSession.clearStorageData()
    await paneSession.clearCache()
    await paneSession.setProxy({ mode: 'direct' })
  }
}

app.on('login', (event, contents, _details, authInfo, callback) => {
  const credentials = webPaneRoutes.proxyCredentials(contents.id, authInfo)
  if (credentials) {
    event.preventDefault()
    callback(credentials.username, credentials.password)
    return
  }
  if (authInfo.isProxy && webPaneRoutes.paneIdForGuest(contents.id)) {
    event.preventDefault()
    callback()
  }
})

function configureWebPaneGuest(
  ownerId: number,
  paneId: string,
  guest: WebContents,
): void {
  const notifyBlocked = (kind: 'loopback' | 'external', url: string): void => {
    const owner = webContents.fromId(ownerId)
    if (!owner || owner.isDestroyed()) return
    owner.send('web-pane:navigation-blocked', { paneId, kind, url })
  }
  const enforceNavigation = (event: Electron.Event, url: string): void => {
    const decision = webPaneRoutes.navigation(guest.id, url)
    if (decision.kind === 'allow') return
    event.preventDefault()
    if (decision.kind === 'loopback' || decision.kind === 'external') {
      notifyBlocked(decision.kind, decision.url)
    }
  }

  guest.setWindowOpenHandler(({ url }) => {
    const decision = webPaneRoutes.navigation(guest.id, url)
    if (decision.kind === 'allow') {
      void guest
        .loadURL(decision.url)
        .catch((error) =>
          console.warn('[web-pane] same-origin window navigation failed', error),
        )
    } else if (decision.kind === 'loopback' || decision.kind === 'external') {
      notifyBlocked(decision.kind, decision.url)
    }
    return { action: 'deny' }
  })
  guest.on('will-navigate', enforceNavigation)
  guest.on('will-redirect', enforceNavigation)
  guest.on('will-prevent-unload', (event) => event.preventDefault())
  guest.on('devtools-opened', () => guest.closeDevTools())
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const bindings = webPaneBindings.get(ownerId) ?? DEFAULT_KEYBINDINGS
    const primaryModifier = process.platform === 'darwin' ? input.meta : input.control
    let action: WebPaneCommandAction | undefined
    if (
      input.key.toLowerCase() === 'w' &&
      primaryModifier &&
      !input.alt &&
      !input.shift
    ) {
      action = 'closeWebPane'
    } else if (input.key === 'Escape' && fullPageWebPanes.get(ownerId) === paneId) {
      action = 'escapeWebPaneFocus'
    } else {
      action = (Object.entries(bindings) as [KeybindingAction, string][]).find(
        ([, binding]) =>
          matchesKeybinding(
            {
              key: input.key,
              code: input.code,
              ctrlKey: input.control,
              metaKey: input.meta,
              altKey: input.alt,
              shiftKey: input.shift,
            },
            binding,
            process.platform === 'darwin',
          ),
      )?.[0]
    }
    if (!action) return
    event.preventDefault()
    const owner = webContents.fromId(ownerId)
    if (owner && !owner.isDestroyed()) {
      owner.send('web-pane:command', { paneId, action })
    }
  })
}

function createWindow(
  discardRendererResources: (ownerId: number) => void = (ownerId) => {
    ptySupervisor?.disposeOwner(ownerId)
    attentionBadge?.update(ownerId, 0)
    sshPrompter?.cancelAll()
    htmlPreviews.clear()
    webPaneBindings.delete(ownerId)
    fullPageWebPanes.delete(ownerId)
    closeWebPanes({ ownerId })
  },
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Webview guests support anti-framing pages and are confined below.
      webviewTag: true,
    },
  })
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const packagedEntry = join(__dirname, '../renderer/index.html')
  const entryUrl = rendererUrl ?? pathToFileURL(packagedEntry).href
  const ownerId = win.webContents.id

  win.on('focus', () => attentionBadge?.setFocused(ownerId, true))
  win.on('blur', () => attentionBadge?.setFocused(ownerId, false))

  win.on('ready-to-show', () => win.show())
  // Renderer reload/crash cannot run React cleanup for its main-owned resources.
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
      // Reload into a fresh renderer that can restore persisted tabs.
      win.webContents.reload()
    }
  })
  win.webContents.once('destroyed', () => discardRendererResources(ownerId))
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
    attentionBadge?.remove(ownerId)
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

  // A one-use main-owned route controls each guest and its security preferences.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = params['partition'] ?? ''
    const paneId =
      params['name'] ||
      (partition.startsWith(WEB_PANE_PARTITION_PREFIX)
        ? partition.slice(WEB_PANE_PARTITION_PREFIX.length)
        : '')
    const route = webPaneRoutes.claimAttachment({
      ownerId,
      paneId,
      partition,
      initialUrl: params['src'] ?? '',
    })
    if (!route) {
      console.warn('[web-pane] blocked unregistered or duplicate guest attachment')
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.devTools = false
    webPreferences.safeDialogs = true
    webPreferences.safeDialogsMessage =
      'hvir stopped this page from opening additional dialogs.'
    params['src'] = route.url
    params['partition'] = route.partition
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    const partition = webPaneSessionPartitions.get(guest.session)
    const paneId = partition
      ? webPaneRoutes.bindGuestForPartition(ownerId, partition, guest.id)
      : undefined
    if (!paneId) {
      console.warn('[web-pane] destroying a guest without an authorized route')
      guest.close({ waitForBeforeUnload: false })
      return
    }
    configureWebPaneGuest(ownerId, paneId, guest)
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
  const requestedProjectRoot = projectRootArgument()
  const registry = await ProjectRegistry.create(
    requestedProjectRoot ? localPath(requestedProjectRoot) : undefined,
    sshPrompter,
    join(app.getPath('userData'), 'known-hosts.json'),
    join(app.getPath('userData'), 'projects.json'),
    (state) => emit('project:state', state),
    async () => {
      const selection = await dialog.showOpenDialog({
        title: 'Choose a folder for hvir',
        defaultPath: process.cwd(),
        properties: ['openDirectory'],
      })
      return selection.canceled || !selection.filePaths[0]
        ? undefined
        : localPath(selection.filePaths[0])
    },
  )
  if (!registry) {
    app.quit()
    return
  }
  projectRegistry = registry
  const metadataHost = projectRegistry.hostById(LOCAL_HOST_ID)
  if (!metadataHost) throw new Error('Local metadata host is unavailable')
  terminalSessionRegistry = await TerminalSessionRegistry.load(
    metadataHost,
    localPath(join(app.getPath('userData'), 'terminal-sessions.json')),
  )
  harnessProfileStore = await HarnessProfileStore.load(
    metadataHost,
    localPath(join(app.getPath('userData'), 'harness-profiles.json')),
  )
  await harnessProfileStore
    .importLegacyDefaults(terminalSessionRegistry.profileReferences())
    .catch((error) =>
      console.warn('[harness] legacy recovery profile import failed', error),
    )
  echoWorker = createWorkerClient<EchoWorkerProtocol>(
    workerPath('echo-worker.js'),
    'hvir-echo',
  )
  gitWorker = createWorkerClient<GitWorkerProtocol>(
    workerPath('git-worker.js'),
    'hvir-git',
    (call) => {
      const path =
        call.operation === 'readTextFile' ? call.path.path : (call.args[1] ?? '')
      const authorization = gitMutationKey(call.hostId, path)
      const pruneArgs = ['worktree', 'prune', '--expire', 'now', '--verbose']
      const requestsWorktreePrune =
        call.operation === 'exec' &&
        call.args.length === pruneArgs.length + 2 &&
        pruneArgs.every((arg, index) => call.args[index + 2] === arg)
      const allowWorktreePrune =
        requestsWorktreePrune && worktreePruneAuthorizations.delete(authorization)
      const requestedBranch =
        call.operation === 'exec' &&
        call.args.length === 5 &&
        call.args[2] === 'switch' &&
        call.args[3] === '--no-guess'
          ? call.args[4]
          : undefined
      const allowBranchSwitch = requestedBranch
        ? branchSwitchAuthorizations.delete(
            gitMutationKey(call.hostId, path, requestedBranch),
          )
          ? requestedBranch
          : undefined
        : undefined
      const requestsFetch =
        call.operation === 'exec' && sameGitArgs(call.args.slice(2), GIT_FETCH_ARGS)
      const requestsPull =
        call.operation === 'exec' && sameGitArgs(call.args.slice(2), GIT_PULL_ARGS)
      const allowFetch = requestsFetch && gitFetchAuthorizations.delete(authorization)
      const allowPull = requestsPull && gitPullAuthorizations.delete(authorization)
      return dispatchWorkerHostCall(
        call,
        projectRegistry?.authorityForPath(call.hostId, path) ?? null,
        { allowWorktreePrune, allowBranchSwitch, allowFetch, allowPull },
      )
    },
  )
  ptySupervisor = new PtySupervisor()
  attentionBadge = new AttentionBadge((count) => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return false
    return app.setBadgeCount(count)
  })
  ptySupervisor.onSessionIdentity((info) => {
    if (info.identityStatus === 'identified' && info.harnessSessionId) {
      void terminalSessionRegistry
        ?.recordIdentity(info.id, info.harnessSessionId)
        .catch((error) => console.error('[terminal] identity persistence failed', error))
    }
    emit('pty:identity', {
      id: info.id,
      harnessSessionId: info.harnessSessionId,
      identityStatus: info.identityStatus,
    })
  })

  registerIpcHandlers({
    echoWorker,
    gitWorker,
    getProject: () => {
      if (!projectRegistry) throw new Error('Project registry is unavailable')
      return projectRegistry.active
    },
    getRegisteredWorkspaceRoot: (root) => projectRegistry?.registeredWorkspaceRoot(root),
    getProjectState: () => {
      if (!projectRegistry) throw new Error('Project registry is unavailable')
      return projectRegistry.state()
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
        for (const project of projectRegistry.state().projects) {
          if (project.registeredRoot.hostId === hostId) {
            void refreshProjectWorkspaces(project.id).catch((error) =>
              console.error('[workspace] refresh after connect failed', error),
            )
          }
        }
        return connected
      }),
    disconnectHost: (hostId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        if (projectRegistry.active.host.hostId === hostId) {
          await stopProjectWatch()
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
        await projectRegistry.open(hostId, path)
        await stopProjectWatch()
        htmlPreviews.clear()
        const state = await refreshProjectWorkspaces(
          projectRegistry.active.projectId,
        ).catch((error) => {
          console.error('[workspace] discovery after registration failed', error)
          return projectRegistry!.state()
        })
        startProjectWatch(projectRegistry.active, emit)
        return state
      }),
    switchWorkspace: (projectId, workspaceId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const state = await projectRegistry.activate(projectId, workspaceId)
        await stopProjectWatch()
        htmlPreviews.clear()
        startProjectWatch(projectRegistry.active, emit)
        return state
      }),
    refreshProject: (projectId) => refreshProjectWorkspaces(projectId),
    updateWatchInterests: (paths) => updateProjectWatchInterests(paths),
    closeProject: (projectId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const wasActive = projectRegistry.active.projectId === projectId
        const closingRoots =
          projectRegistry.projectById(projectId)?.workspaces.map(({ root }) => root) ?? []
        if (wasActive) await stopProjectWatch()
        try {
          await workspaceRefreshes.get(projectId)?.catch(() => undefined)
          workspaceRefreshes.delete(projectId)
          const refreshTimer = workspaceRefreshTimers.get(projectId)
          if (refreshTimer) clearTimeout(refreshTimer)
          workspaceRefreshTimers.delete(projectId)
          const state = await projectRegistry.closeProject(projectId)
          await Promise.all(
            closingRoots.map((root) => webPaneRoutes.closeWorkspace(root)),
          )
          if (wasActive) {
            htmlPreviews.clear()
          }
          return state
        } finally {
          if (wasActive && projectRegistry.active.host.connectionState === 'connected') {
            startProjectWatch(projectRegistry.active, emit)
          }
        }
      }),
    pruneWorktrees: (projectId) => requestProjectWorktreePrune(projectId, emit),
    dismissWorkspace: (projectId, workspaceId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const workspace = projectRegistry
          .projectById(projectId)
          ?.workspaces.find((candidate) => candidate.id === workspaceId)
        if (workspace?.missing) {
          await Promise.all(
            terminalSessionRegistry
              ?.list(workspace.root)
              .map((session) =>
                terminalSessionRegistry!.forget(workspace.root, session.id),
              ) ?? [],
          )
        }
        const wasActive = projectRegistry.active.workspaceId === workspaceId
        const state = await projectRegistry.dismissWorkspace(projectId, workspaceId)
        if (workspace) await webPaneRoutes.closeWorkspace(workspace.root)
        if (wasActive) {
          await stopProjectWatch()
          startProjectWatch(projectRegistry.active, emit)
        }
        return state
      }),
    switchGitBranch: (root, branch) => requestGitBranchSwitch(root, branch),
    fetchGit: (root) => requestGitFetch(root),
    pullGit: (root) => requestGitPull(root),
    respondSshPrompt: (id, answers) => sshPrompter?.respond(id, answers),
    ptySupervisor,
    terminalSessions: terminalSessionRegistry,
    harnessProfiles: harnessProfileStore,
    harnessProbes: harnessProbeManager,
    updateAttention: (ownerId, count) => attentionBadge?.update(ownerId, count),
    updateWebPaneBindings: (ownerId, bindings) => webPaneBindings.set(ownerId, bindings),
    updateWebPaneFullPage: (ownerId, paneId) => {
      if (paneId) fullPageWebPanes.set(ownerId, paneId)
      else fullPageWebPanes.delete(ownerId)
    },
    htmlPreviews,
    webPanes: webPaneRoutes,
    openExternal: (url) => shell.openExternal(url),
    emit,
  })
  // Paint the workbench before background watch and Git discovery can touch a
  // slow or unexpectedly broad directory.
  createWindow()
  if (projectRegistry.active.host.connectionState === 'connected') {
    startProjectWatch(projectRegistry.active, emit)
    void refreshProjectWorkspaces(projectRegistry.active.projectId).catch((error) =>
      console.error('[workspace] initial discovery failed', error),
    )
  }
  workspacePoll = setInterval(() => {
    if (shutdownStarted || BrowserWindow.getAllWindows().length === 0) return
    const registry = projectRegistry
    if (!registry) return
    for (const project of registry.state().projects) {
      if (project.connectionState !== 'connected') continue
      if (project.workspaces.every((workspace) => workspace.repository === false)) {
        continue
      }
      void refreshProjectWorkspaces(project.id).catch((error) =>
        console.error(`[workspace] periodic refresh failed for ${project.id}`, error),
      )
    }
  }, 5_000)
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
  projectWatchInterestGeneration++
  projectWatchInterestCache.clear()
  const controller = projectWatchController
  projectWatchController = null
  await controller?.dispose()
}

function refreshProjectWorkspaces(projectId: string): Promise<ProjectState> {
  const pruning = workspacePrunes.get(projectId)
  if (pruning) return pruning
  const existing = workspaceRefreshes.get(projectId)
  if (existing) return existing
  const refresh = (async (): Promise<ProjectState> => {
    const registry = projectRegistry
    const worker = gitWorker
    if (!registry || !worker) throw new Error('Workspace discovery is unavailable')
    const project = registry.projectById(projectId)
    if (!project) throw new Error('Unknown project')
    if (project.connectionState !== 'connected') return registry.state()
    const discovery = await worker.request(GIT_WORKTREES_TYPE, {
      root: project.registeredRoot,
    })
    await registry.reconcileWorktrees(projectId, discovery)
    const refreshed = registry.projectById(projectId)
    if (!refreshed || !discovery.repository) return registry.state()
    const present = refreshed.workspaces.filter((workspace) => !workspace.missing)
    const relatedWorktreeRoots = present.map((workspace) => workspace.root)
    const counts = new Map<string, number>()
    for (let index = 0; index < present.length; index += 3) {
      await Promise.all(
        present.slice(index, index + 3).map(async (workspace) => {
          counts.set(
            workspace.id,
            await worker.request(GIT_CHANGED_FILE_COUNT_TYPE, {
              root: workspace.root,
              relatedWorktreeRoots,
            }),
          )
        }),
      )
    }
    return registry.updateChangedCounts(projectId, counts)
  })()
  workspaceRefreshes.set(projectId, refresh)
  void refresh.then(
    () => {
      if (workspaceRefreshes.get(projectId) === refresh)
        workspaceRefreshes.delete(projectId)
    },
    () => {
      if (workspaceRefreshes.get(projectId) === refresh)
        workspaceRefreshes.delete(projectId)
    },
  )
  return refresh
}

function requestProjectWorktreePrune(
  projectId: string,
  emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void,
): Promise<ProjectState> {
  const existing = workspacePrunes.get(projectId)
  if (existing) return existing
  const prune = serializeSession(() => pruneProjectWorktrees(projectId, emit))
  workspacePrunes.set(projectId, prune)
  void prune.then(
    () => {
      if (workspacePrunes.get(projectId) === prune) workspacePrunes.delete(projectId)
    },
    () => {
      if (workspacePrunes.get(projectId) === prune) workspacePrunes.delete(projectId)
    },
  )
  return prune
}

async function pruneProjectWorktrees(
  projectId: string,
  emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void,
): Promise<ProjectState> {
  const registry = projectRegistry
  const worker = gitWorker
  const sessions = terminalSessionRegistry
  if (!registry || !worker || !sessions) {
    throw new Error('Workspace pruning is unavailable')
  }
  await workspaceRefreshes.get(projectId)?.catch(() => undefined)
  const project = registry.projectById(projectId)
  if (!project) throw new Error('Unknown project')
  if (project.connectionState !== 'connected') {
    throw new Error('Connect to the project host before pruning worktrees')
  }
  const targets = project.workspaces.filter(
    (workspace) => workspace.missing && workspace.prunableReason !== undefined,
  )
  if (targets.length === 0) throw new Error('Git reports no prunable worktrees')
  const prunesActiveWorkspace = targets.some(
    (workspace) => workspace.id === registry.active.workspaceId,
  )

  const authorization = gitMutationKey(
    project.registeredRoot.hostId,
    project.registeredRoot.path,
  )
  if (worktreePruneAuthorizations.has(authorization)) {
    throw new Error('A worktree prune is already running for this project')
  }
  worktreePruneAuthorizations.add(authorization)
  let discovery: WorktreeDiscovery
  try {
    discovery = await worker.request(GIT_PRUNE_WORKTREES_TYPE, {
      root: project.registeredRoot,
    })
  } finally {
    worktreePruneAuthorizations.delete(authorization)
  }

  await registry.reconcileWorktrees(projectId, discovery)
  for (const target of targets) {
    if (
      discovery.worktrees.some((worktree) => hostPathEquals(worktree.root, target.root))
    ) {
      continue
    }
    await Promise.all(
      sessions
        .list(target.root)
        .map((session) => sessions.forget(target.root, session.id)),
    )
    await registry.dismissWorkspace(projectId, target.id)
    await webPaneRoutes.closeWorkspace(target.root)
  }
  if (prunesActiveWorkspace) {
    await stopProjectWatch()
    htmlPreviews.clear()
    startProjectWatch(registry.active, emit)
  }
  return registry.state()
}

function requestGitBranchSwitch(root: HostPath, branch: string): Promise<ProjectState> {
  return serializeSession(async () => {
    const registry = projectRegistry
    const worker = gitWorker
    if (!registry || !worker) throw new Error('Branch switching is unavailable')
    if (!hostPathEquals(root, registry.active.root)) {
      throw new Error('Branch switch belongs to another workspace')
    }
    if (registry.active.host.connectionState !== 'connected') {
      throw new Error('Reconnect before switching branches')
    }
    if (
      typeof branch !== 'string' ||
      branch.length === 0 ||
      branch.length > 1_024 ||
      branch.includes('\0')
    ) {
      throw new Error('Invalid branch target')
    }

    const projectId = registry.active.projectId
    await workspaceRefreshes.get(projectId)?.catch(() => undefined)
    workspaceRefreshes.delete(projectId)
    const authorization = gitMutationKey(root.hostId, root.path, branch)
    if (branchSwitchAuthorizations.has(authorization)) {
      throw new Error('A branch switch is already running for this workspace')
    }
    branchSwitchAuthorizations.add(authorization)
    try {
      const relatedWorktreeRoots =
        registry
          .projectById(projectId)
          ?.workspaces.filter((workspace) => !workspace.missing)
          .map((workspace) => workspace.root) ?? []
      await worker.request(GIT_SWITCH_BRANCH_TYPE, {
        root,
        branch,
        relatedWorktreeRoots,
      })
    } finally {
      branchSwitchAuthorizations.delete(authorization)
    }
    try {
      return await refreshProjectWorkspaces(projectId)
    } catch (error) {
      console.error('[git] workspace refresh after branch switch failed', error)
      scheduleWorkspaceRefresh(projectId)
      return registry.state()
    }
  })
}

function requestGitFetch(root: HostPath): Promise<ProjectState> {
  return serializeSession(async () => {
    const registry = projectRegistry
    const worker = gitWorker
    if (!registry || !worker) throw new Error('Git fetch is unavailable')
    assertActiveGitWorkspace(root, registry, 'fetching')
    const authorization = gitMutationKey(root.hostId, root.path)
    if (gitFetchAuthorizations.has(authorization)) {
      throw new Error('A fetch is already running for this workspace')
    }
    gitFetchAuthorizations.add(authorization)
    try {
      await worker.request(GIT_FETCH_TYPE, { root })
    } finally {
      gitFetchAuthorizations.delete(authorization)
    }
    return registry.state()
  })
}

function requestGitPull(root: HostPath): Promise<ProjectState> {
  return serializeSession(async () => {
    const registry = projectRegistry
    const worker = gitWorker
    if (!registry || !worker) throw new Error('Git pull is unavailable')
    assertActiveGitWorkspace(root, registry, 'pulling')
    const projectId = registry.active.projectId
    const authorization = gitMutationKey(root.hostId, root.path)
    if (gitPullAuthorizations.has(authorization)) {
      throw new Error('A pull is already running for this workspace')
    }
    gitPullAuthorizations.add(authorization)
    try {
      const relatedWorktreeRoots =
        registry
          .projectById(projectId)
          ?.workspaces.filter((workspace) => !workspace.missing)
          .map((workspace) => workspace.root) ?? []
      await worker.request(GIT_PULL_TYPE, { root, relatedWorktreeRoots })
    } finally {
      gitPullAuthorizations.delete(authorization)
    }
    try {
      return await refreshProjectWorkspaces(projectId)
    } catch (error) {
      console.error('[git] workspace refresh after pull failed', error)
      scheduleWorkspaceRefresh(projectId)
      return registry.state()
    }
  })
}

function assertActiveGitWorkspace(
  root: HostPath,
  registry: ProjectRegistry,
  operation: string,
): void {
  if (!hostPathEquals(root, registry.active.root)) {
    throw new Error(`Git ${operation} belongs to another workspace`)
  }
  if (registry.active.host.connectionState !== 'connected') {
    throw new Error(`Reconnect before ${operation}`)
  }
}

function sameGitArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((arg, index) => arg === expected[index])
  )
}

function scheduleWorkspaceRefresh(projectId: string): void {
  if (shutdownStarted) return
  const existing = workspaceRefreshTimers.get(projectId)
  if (existing) clearTimeout(existing)
  workspaceRefreshTimers.set(
    projectId,
    setTimeout(() => {
      workspaceRefreshTimers.delete(projectId)
      void refreshProjectWorkspaces(projectId).catch((error) =>
        console.error('[workspace] watch refresh failed', error),
      )
    }, 350),
  )
}

function startProjectWatch(
  project: {
    readonly host: ProjectHost
    readonly root: HostPath
    readonly projectId: string
  },
  emit: <E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>) => void,
): void {
  projectWatchInterestGeneration++
  projectWatchInterestCache = new Map()
  projectWatchController = new ProjectWatchController(project, {
    emit: (event) => emit('project:watch', event),
    refreshGit: () => scheduleWorkspaceRefresh(project.projectId),
    repositoryEnabled: () => {
      const workspace = projectRegistry
        ?.projectById(project.projectId)
        ?.workspaces.find(
          (candidate) => candidate.id === projectRegistry?.active.workspaceId,
        )
      return workspace?.repository === true
    },
  })
}

async function updateProjectWatchInterests(
  requestedPaths: readonly HostPath[],
): Promise<{ readonly accepted: number; readonly limited: boolean }> {
  const registry = projectRegistry
  const controller = projectWatchController
  if (!registry || !controller) throw new Error('Project watch is unavailable')
  const generation = ++projectWatchInterestGeneration
  const { host, root } = registry.active
  if (!hostPathEquals(controller.target.root, root)) {
    throw new Error('Project watch changed while interests were being updated')
  }
  const canonical = await canonicalProjectWatchInterests(
    host,
    root,
    requestedPaths,
    MAX_PROJECT_WATCH_INTERESTS,
    projectWatchInterestCache,
  )
  if (
    generation !== projectWatchInterestGeneration ||
    projectWatchController !== controller ||
    !projectRegistry ||
    !hostPathEquals(projectRegistry.active.root, root)
  ) {
    throw new Error('Project watch changed while interests were being updated')
  }
  controller.updateInterests(canonical.paths)
  return { accepted: canonical.paths.length, limited: canonical.limited }
}

function serializeSession<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionOperation.then(operation, operation)
  sessionOperation = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function gitMutationKey(hostId: string, path: string, target?: string): string {
  return JSON.stringify(target === undefined ? [hostId, path] : [hostId, path, target])
}

function projectRootArgument(): string | undefined {
  const fromFlag = process.argv.find((arg) => arg.startsWith('--project-root='))
  return fromFlag?.slice('--project-root='.length) || process.env.HVIR_PROJECT_ROOT
}

void app
  .whenReady()
  .then(async () => {
    htmlPreviews.register()
    if (process.env['HVIR_SMOKE']) {
      const { runSmoke } = await import('./smoke')
      const code = await runSmoke({
        mode: process.env['HVIR_CAPACITY_SMOKE'] ? 'capacity' : 'workflow',
        createWindow,
        harnessProbeManager,
        htmlPreviews,
        webPaneRoutes,
        updateWebPaneBindings: (ownerId, bindings) =>
          webPaneBindings.set(ownerId, bindings),
        updateWebPaneFullPage: (ownerId, paneId) => {
          if (paneId) fullPageWebPanes.set(ownerId, paneId)
          else fullPageWebPanes.delete(ownerId)
        },
        openExternal: (url) => shell.openExternal(url),
      })
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
  await settleWorkspaceRefreshes()
  ptySupervisor?.disposeSessions()
  htmlPreviews.clear()
  await webPaneRoutes
    .closeAll()
    .catch((error) => console.error('[web-pane] suspend cleanup failed', error))
  sshPrompter?.cancelAll()
  await terminalSessionRegistry?.flush()
  await harnessProfileStore?.flush()
  await projectRegistry?.disconnectSshHosts()
}

async function shutdown(): Promise<void> {
  sshPrompter?.cancelAll()
  if (workspacePoll) clearInterval(workspacePoll)
  workspacePoll = null
  for (const timer of workspaceRefreshTimers.values()) clearTimeout(timer)
  workspaceRefreshTimers.clear()
  await suspendSessions
  await stopProjectWatch().catch((error) =>
    console.error('[shutdown] watcher cleanup failed', error),
  )
  await settleWorkspaceRefreshes()
  await ptySupervisor?.disposeAllAndWait()
  ptySupervisor = null
  attentionBadge?.clear()
  attentionBadge = null
  await terminalSessionRegistry
    ?.flush()
    .catch((error) => console.error('[shutdown] terminal persistence failed', error))
  terminalSessionRegistry = null
  await harnessProfileStore
    ?.flush()
    .catch((error) =>
      console.error('[shutdown] harness profile persistence failed', error),
    )
  harnessProfileStore = null
  const registry = projectRegistry
  await registry
    ?.dispose()
    .catch((error) => console.error('[shutdown] host cleanup failed', error))
  projectRegistry = null
  sshPrompter = null
  echoWorker?.dispose()
  echoWorker = null
  gitWorker?.dispose()
  gitWorker = null
  htmlPreviews.dispose()
  await webPaneRoutes
    .closeAll()
    .catch((error) => console.error('[shutdown] web-pane cleanup failed', error))
  harnessProbeManager.dispose()
}

async function settleWorkspaceRefreshes(): Promise<void> {
  await Promise.allSettled([...workspaceRefreshes.values()])
}
