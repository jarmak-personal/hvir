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
import { AttentionBadge } from './attention-badge'
import {
  TerminalSessionRegistry,
  type TerminalSessionStore,
} from './terminal/session-registry'
import {
  ECHO_REQUEST_TYPE,
  GIT_CHANGED_FILE_COUNT_TYPE,
  GIT_PRUNE_WORKTREES_TYPE,
  GIT_WORKTREES_TYPE,
  GIT_SWITCH_BRANCH_TYPE,
  hostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  LOCAL_HOST_ID,
  type Disposer,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  type TerminalRecoverySession,
  type ProjectState,
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

let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
let gitWorker: WorkerClient<GitWorkerProtocol> | null = null
let projectRegistry: ProjectRegistry | null = null
let sshPrompter: RendererSshPrompter | null = null
let ptySupervisor: PtySupervisor | null = null
let terminalSessionRegistry: TerminalSessionRegistry | null = null
let attentionBadge: AttentionBadge | null = null
let disposeWatch: Disposer | null = null
let workspacePoll: ReturnType<typeof setInterval> | null = null
const workspaceRefreshes = new Map<string, Promise<ProjectState>>()
const workspaceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const workspacePrunes = new Map<string, Promise<ProjectState>>()
const worktreePruneAuthorizations = new Set<string>()
const branchSwitchAuthorizations = new Set<string>()
let sessionOperation: Promise<void> = Promise.resolve()
let suspendSessions: Promise<void> = Promise.resolve()
let shutdownStarted = false
let shutdownComplete = false

function createWindow(
  discardRendererResources: (ownerId: number) => void = (ownerId) => {
    ptySupervisor?.disposeOwner(ownerId)
    attentionBadge?.update(ownerId, 0)
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

  win.on('focus', () => attentionBadge?.setFocused(ownerId, true))
  win.on('blur', () => attentionBadge?.setFocused(ownerId, false))

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
    join(app.getPath('userData'), 'projects.json'),
    (state) => emit('project:state', state),
  )
  const metadataHost = projectRegistry.hostById(LOCAL_HOST_ID)
  if (!metadataHost) throw new Error('Local metadata host is unavailable')
  terminalSessionRegistry = await TerminalSessionRegistry.load(
    metadataHost,
    localPath(join(app.getPath('userData'), 'terminal-sessions.json')),
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
      return dispatchWorkerHostCall(
        call,
        projectRegistry?.authorityForPath(call.hostId, path) ?? null,
        { allowWorktreePrune, allowBranchSwitch },
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
    closeProject: (projectId) =>
      serializeSession(async () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        const wasActive = projectRegistry.active.projectId === projectId
        if (wasActive) await stopProjectWatch()
        try {
          await workspaceRefreshes.get(projectId)?.catch(() => undefined)
          workspaceRefreshes.delete(projectId)
          const refreshTimer = workspaceRefreshTimers.get(projectId)
          if (refreshTimer) clearTimeout(refreshTimer)
          workspaceRefreshTimers.delete(projectId)
          const state = await projectRegistry.closeProject(projectId)
          if (wasActive) htmlPreviews.clear()
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
        if (wasActive) {
          await stopProjectWatch()
          startProjectWatch(projectRegistry.active, emit)
        }
        return state
      }),
    switchGitBranch: (root, branch) => requestGitBranchSwitch(root, branch),
    respondSshPrompt: (id, answers) => sshPrompter?.respond(id, answers),
    ptySupervisor,
    terminalSessions: terminalSessionRegistry,
    updateAttention: (ownerId, count) => attentionBadge?.update(ownerId, count),
    htmlPreviews,
    emit,
  })
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
      void refreshProjectWorkspaces(project.id).catch((error) =>
        console.error(`[workspace] periodic refresh failed for ${project.id}`, error),
      )
    }
  }, 5_000)
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
  const pendingWatchEvents = new Map<string, IpcEventPayload<'project:watch'>>()
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const stops: Disposer[] = []
  const receive = (event: IpcEventPayload<'project:watch'>): void => {
    if (stopped) return
    scheduleWorkspaceRefresh(project.projectId)
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

function gitMutationKey(hostId: string, path: string, target?: string): string {
  return JSON.stringify(target === undefined ? [hostId, path] : [hostId, path, target])
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
  const smokeCloseableRoot = joinHostPath(smokeRoot, '.hvir-smoke-closed-project')
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
  const liveReloadPath = joinHostPath(smokeRoot, '.hvir-smoke-live.txt')
  const largeJsonPath = joinHostPath(smokeRoot, '.hvir-smoke-large.json')
  const largeTextPath = joinHostPath(smokeRoot, '.hvir-smoke-large.txt')
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
      authorizeResume: () => false,
      flush: () => Promise.resolve(),
    }
    registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      getProject: () => ({ host, root: smokeRoot }),
      getRegisteredWorkspaceRoot: (root) =>
        hostPathEquals(root, smokeRoot) || hostPathEquals(root, smokeCloseableRoot)
          ? root
          : undefined,
      getProjectState: () => smokeProjectState(),
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
      closeProject: () => Promise.resolve(smokeProjectState()),
      pruneWorktrees: () => Promise.resolve(smokeProjectState()),
      dismissWorkspace: () => Promise.resolve(smokeProjectState()),
      switchGitBranch: () => Promise.resolve(smokeProjectState()),
      respondSshPrompt: () => undefined,
      ptySupervisor: supervisor,
      terminalSessions: smokeTerminalSessions,
      updateAttention: () => undefined,
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
        const caret = getComputedStyle(host).caretColor;
        if (caret !== 'transparent' && caret !== 'rgba(0, 0, 0, 0)') {
          throw new Error('browser caret is visible in terminal input host: ' + caret);
        }
        return 'headerless · canvas cursor only';
      })()
    `)) as string
    console.log(`[smoke] terminal input caret contained (${terminalCaretStatus})`)

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
                ' hostChanged=' + (host !== window.__hvirSmokeTerminalHost) +
                ' oldDetached=' + (!window.__hvirSmokeTerminalHost?.isConnected);
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
    if (process.env['HVIR_CAPACITY_SMOKE']) {
      await runCapacityLoadSmoke(win, supervisor, host, liveReloadPath)
      smokeRecoverySessions = supervisor.list().map((terminal, position) => ({
        id: terminal.id,
        adapterId: 'plain-shell',
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
          const toggle = document.querySelector('.theme-toggle');
          const shell = document.querySelector('.app-shell');
          if (!canvas || !toggle || !shell) return reject(new Error('theme smoke controls missing'));
          const before = getComputedStyle(shell).backgroundColor;
          const terminalBefore = getComputedStyle(canvas).filter;
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
            const missing = missingActivated ? undefined : link('Missing target');
            if (missing && !missingActivated) {
              missingActivated = true;
              missing.click();
              return setTimeout(waitForContainedError, 50);
            }
            if (Date.now() > deadline) return reject(new Error(
              'missing internal link escaped the viewer: ' +
              (document.querySelector('.viewer-title')?.textContent || 'no title')
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

    const modeBinding = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const activeMode = () => document.querySelector('.mode-control button.active')?.textContent?.trim();
        const before = activeMode();
        const terminal = document.querySelector('.terminal-panel');
        const mac = /Mac/.test(navigator.platform);
        terminal?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'M', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true
        }));
        if (activeMode() !== before) return reject(new Error('terminal chord changed viewer mode'));
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'M', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true
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
                .find((node) => node.getAttribute('title')?.endsWith('/package.json')),
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
            const longFile = await waitFor(
              () => [...document.querySelectorAll('.file-row')]
                .find((node) => node.getAttribute('title') ===
                  ${JSON.stringify(liveReloadPath.path)}),
              'long diff fixture missing'
            );
            longFile.click();
            await waitFor(
              () => document.querySelector('.viewer-title')?.textContent
                ?.includes('.hvir-smoke-live.txt'),
              'long diff fixture did not become active'
            );
            const longDiffButton = await waitFor(
              () => [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.textContent?.trim() === 'diff'),
              'long diff mode button missing'
            );
            longDiffButton.click();
            const scrollableMerge = await waitFor(
              () => {
                const merge = document.querySelector('.cm-mergeView');
                return merge && merge.scrollHeight > merge.clientHeight + 40
                  ? merge
                  : undefined;
              },
              'long diff did not create scroll extent'
            );
            scrollableMerge.scrollTop = 120;
            scrollableMerge.dispatchEvent(new Event('scroll'));
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            if (scrollableMerge.scrollTop < 100) {
              throw new Error('long diff scroll position did not move');
            }
            const visibleLine = (root, selector) => {
              const viewportTop = root.getBoundingClientRect().top;
              const markers = [...root.querySelectorAll(selector)]
                .filter((node) => /^[0-9]+$/.test(node.textContent?.trim() || ''))
                .sort((left, right) =>
                  left.getBoundingClientRect().top - right.getBoundingClientRect().top
                );
              const marker = markers.find(
                (node) => node.getBoundingClientRect().bottom > viewportTop + 1
              );
              return marker ? Number(marker.textContent?.trim()) : undefined;
            };
            const initialDiffLine = visibleLine(
              scrollableMerge,
              '.cm-merge-b .cm-lineNumbers .cm-gutterElement'
            );
            const sourceButton = [...document.querySelectorAll('.mode-control button')]
              .find((node) => node.textContent?.trim() === 'source');
            sourceButton?.click();
            const sourceScroller = await waitFor(
              () => document.querySelector('.source-shell .cm-scroller'),
              'source view did not replace long diff'
            );
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            const restoredSourceLine = visibleLine(
              sourceScroller,
              '.cm-lineNumbers .cm-gutterElement'
            );
            if (
              initialDiffLine === undefined ||
              restoredSourceLine === undefined ||
              Math.abs(restoredSourceLine - initialDiffLine) > 1
            ) {
              throw new Error(
                'diff→source line changed: ' + initialDiffLine + '→' + restoredSourceLine +
                  ' at ' + Math.round(sourceScroller.scrollTop) + 'px'
              );
            }
            sourceScroller.scrollTop = Math.min(
              900,
              sourceScroller.scrollHeight - sourceScroller.clientHeight
            );
            sourceScroller.dispatchEvent(new Event('scroll'));
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            const sourceLine = visibleLine(
              sourceScroller,
              '.cm-lineNumbers .cm-gutterElement'
            );
            const returnToDiff = [...document.querySelectorAll('.mode-control button')]
              .find((node) => node.textContent?.trim() === 'diff');
            returnToDiff?.click();
            const restoredMerge = await waitFor(
              () => {
                const merge = document.querySelector('.cm-mergeView');
                return merge && merge.scrollHeight > merge.clientHeight + 40
                  ? merge
                  : undefined;
              },
              'diff did not return after source scroll'
            );
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            const restoredDiffLine = visibleLine(
              restoredMerge,
              '.cm-merge-b .cm-lineNumbers .cm-gutterElement'
            );
            if (
              sourceLine === undefined ||
              restoredDiffLine === undefined ||
              Math.abs(restoredDiffLine - sourceLine) > 1
            ) {
              throw new Error(
                'source→diff line changed: ' + sourceLine + '→' + restoredDiffLine
              );
            }
            resolve(
              expectations.map(([base]) => base).join(', ') +
                ' · line anchor ' + initialDiffLine + '→' + sourceLine + '→' + restoredDiffLine
            );
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
              .find((node) => node.getAttribute('title')?.endsWith('/package-lock.json'));
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

    const sessionFlowStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const sessionBar = document.querySelector('.session-bar');
        const sessionText = sessionBar?.textContent || '';
        if (sessionBar?.querySelector('.remote-connection-badge')) {
          return reject(new Error('local session shows a remote connection badge'));
        }
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
          const treeDivider = document.querySelector('.tree-resizer');
          const terminalDivider = document.querySelector('.terminal-resizer');
          const treeToggle = document.querySelector('.tree-collapse-toggle');
          const terminalToggle = document.querySelector('.terminal-focus-toggle');
          if (
            !tree || !workbench || !viewer || !terminal || !terminalRail ||
            !treeDivider || !terminalDivider || !treeToggle || !terminalToggle
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
                  terminalToggle.click();
                  treeToggle.click();
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const finalTreeWidth = tree.getBoundingClientRect().width;
                    if (
                      workbench.classList.contains('tree-collapsed') ||
                      workbench.classList.contains('terminal-focused') ||
                      Math.abs(finalTreeWidth - restoredTreeWidth) > 1 ||
                      getComputedStyle(tree).visibility === 'hidden'
                    ) {
                      return reject(new Error('pane focus modes did not restore'));
                    }
                    resolve(
                      Math.round(treeBefore) + '→' + Math.round(treeAfter) + 'px tree; ' +
                      Math.round(terminalBefore) + '→' + Math.round(terminalAfter) +
                      'px terminal; collapse composed and restored'
                    );
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
            const keybindings = dialog?.querySelector('.settings-keybindings textarea');
            const fields = dialog?.querySelectorAll('select, input, textarea').length || 0;
            if (!dialog || !keybindings || fields < 5 ||
                !keybindings.value.includes('toggleTerminalFocus')) {
              return reject(new Error('settings surface incomplete'));
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
              const idle = openDialog.querySelector('input[type="number"]');
              if (!idle) return reject(new Error('idle threshold control missing'));
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                ?.set?.call(idle, '');
              idle.dispatchEvent(new Event('input', { bubbles: true }));
              requestAnimationFrame(() => {
                [...openDialog.querySelectorAll('button')]
                  .find((button) => button.textContent?.trim() === 'Save')?.click();
                requestAnimationFrame(() => {
                  const validation = document.querySelector('.settings-dialog .dialog-error')
                    ?.textContent || '';
                  if (!/idle threshold/i.test(validation)) {
                    return reject(new Error('blank idle threshold did not show validation'));
                  }
                  [...openDialog.querySelectorAll('button')]
                    .find((button) => button.textContent?.trim() === 'Cancel')?.click();
                  requestAnimationFrame(() => {
                    if (document.querySelector('.settings-dialog')) {
                      return reject(new Error('settings dialog did not close'));
                    }
                    resolve(fields + ' controls · modal isolation · validation');
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

    const closeableState = smokeProjectState()
    emit('project:state', {
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
    })
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
        adapterId: 'plain-shell',
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
    await host.exec('rm', ['-f', '--', largeTextPath.path])
    await host.dispose()
    worker.dispose()
    git.dispose()
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
          const activeStatus = document.querySelector(
            '.terminal-surface.active .panel-meta'
          )?.textContent || '';
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
              .find((node) => node.textContent?.trim() === 'Shell'),
            'shell menu item unavailable'
          );
          shell.click();
          await waitFor(() => {
            const rows = [...document.querySelectorAll('.terminal-list-row')];
            const activeStatus = document.querySelector(
              '.terminal-surface.active .panel-meta'
            )?.textContent || '';
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
  await settleWorkspaceRefreshes()
  ptySupervisor?.disposeSessions()
  htmlPreviews.clear()
  sshPrompter?.cancelAll()
  await terminalSessionRegistry?.flush()
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
  ptySupervisor?.disposeAll()
  ptySupervisor = null
  attentionBadge?.clear()
  attentionBadge = null
  await terminalSessionRegistry
    ?.flush()
    .catch((error) => console.error('[shutdown] terminal persistence failed', error))
  terminalSessionRegistry = null
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
}

async function settleWorkspaceRefreshes(): Promise<void> {
  await Promise.allSettled([...workspaceRefreshes.values()])
}
