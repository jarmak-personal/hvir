/** Electron main-process entry and current application composition root. */

import { join } from 'node:path'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { dispatchWorkerHostCall } from './git/worker-host-broker'
import { GIT_FETCH_ARGS, GIT_PULL_ARGS } from './git/git-engine'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import type { ProjectHost } from './project-host'
import { ProjectRegistry, RendererSshPrompter } from './project-registry'
import { PtySupervisor } from './pty/pty-supervisor'
import { AttentionBadge } from './attention-badge'
import { HarnessProfileStore } from './harness/harness-profile-store'
import { HarnessProbeManager } from './harness/harness-probe'
import {
  canonicalProjectWatchInterests,
  ProjectWatchController,
  type ProjectWatchInterestCache,
} from './project-watch'
import { TerminalSessionRegistry } from './terminal/session-registry'
import { RendererResourceScopes, type RendererOwner } from './renderer-resource-scopes'
import { createElectronWindowManager } from './window/electron-window-manager'
import { WorkbenchRuntime } from './workbench-runtime'
import {
  GIT_CHANGED_FILE_COUNT_TYPE,
  GIT_PRUNE_WORKTREES_TYPE,
  GIT_WORKTREES_TYPE,
  GIT_FETCH_TYPE,
  GIT_PULL_TYPE,
  GIT_SWITCH_BRANCH_TYPE,
  MAX_PROJECT_WATCH_INTERESTS,
  hostPathEquals,
  localPath,
  LOCAL_HOST_ID,
  type EchoWorkerProtocol,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
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

function createWorkbenchEntry(): void {
  const runtime = new WorkbenchRuntime({
    start: startup,
    suspend: suspendWorkbenchSessions,
    reopen: reopenWorkbench,
    shutdown,
  })
  const htmlPreviews = runtime.own(
    'HTML preview protocol',
    new HtmlPreviewProtocol(),
    (previews) => previews.dispose(),
  )
  const harnessProbeManager = runtime.own(
    'harness probe manager',
    new HarnessProbeManager(),
    (probes) => probes.dispose(),
  )
  const rendererScopes = runtime.own(
    'renderer resource scopes',
    new RendererResourceScopes(),
    (scopes) => scopes.dispose(),
  )

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

  const installRendererPresentation = (owner: RendererOwner): RendererOwner => {
    rendererScopes.register(owner, { lifetime: 'renderer', type: 'attention' }, () =>
      attentionBadge?.remove(owner.id, owner.generation),
    )
    rendererScopes.register(
      owner,
      { lifetime: 'renderer', type: 'ssh-prompt-presentation' },
      () => sshPrompter?.revokeOwner(owner),
    )
    return owner
  }

  const windowManager = runtime.own(
    'Electron window manager',
    createElectronWindowManager({
      htmlPreviews,
      discardRendererResources: () => undefined,
      activateRenderer: (ownerId) =>
        installRendererPresentation(rendererScopes.activateOwner(ownerId)),
      rolloverRenderer: (owner) => {
        const transition = rendererScopes.rolloverOwner(owner.id)
        void transition.cleanup.catch((error) =>
          console.error('[renderer] generation cleanup failed', error),
        )
        return installRendererPresentation(transition.owner)
      },
      revokeRenderer: (owner) => {
        void rendererScopes
          .revokeOwner(owner.id)
          .catch((error) => console.error('[renderer] owner cleanup failed', error))
      },
      isRendererCurrent: (owner) => rendererScopes.isCurrent(owner),
      setOwnerFocused: (owner, focused) =>
        attentionBadge?.setFocused(owner.id, focused, owner.generation),
      onLastWindowClosed: () => {
        void runtime
          .suspend()
          .catch((error) =>
            console.error('[session] cleanup after window close failed', error),
          )
      },
      isShuttingDown: () => runtime.isShuttingDown,
    }),
    (manager) => manager.dispose(),
  )
  const webPaneRoutes = windowManager.routes
  const createWindow = windowManager.createWindow

  function emitToWindows<E extends IpcEventChannel>(
    channel: E,
    payload: IpcEventPayload<E>,
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  function emitToRenderer<E extends IpcEventChannel>(
    owner: RendererOwner,
    channel: E,
    payload: IpcEventPayload<E>,
  ): void {
    if (!rendererScopes.isCurrent(owner)) return
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === owner.id,
    )
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  async function startup(): Promise<void> {
    htmlPreviews.register()
    const emit = emitToWindows
    sshPrompter = runtime.own(
      'SSH prompter',
      new RendererSshPrompter(
        (owner, prompt) => emitToRenderer(owner, 'ssh:prompt', prompt),
        (owner, hostId) => emitToRenderer(owner, 'ssh:prompt-cancel', { hostId }),
      ),
      (prompter) => prompter.cancelAll(),
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
    projectRegistry = runtime.own('project registry', registry, (ownedRegistry) =>
      ownedRegistry.dispose(),
    )
    const metadataHost = projectRegistry.hostById(LOCAL_HOST_ID)
    if (!metadataHost) throw new Error('Local metadata host is unavailable')
    terminalSessionRegistry = runtime.own(
      'terminal session registry',
      await TerminalSessionRegistry.load(
        metadataHost,
        localPath(join(app.getPath('userData'), 'terminal-sessions.json')),
      ),
      (sessions) => sessions.flush(),
    )
    harnessProfileStore = runtime.own(
      'harness profile store',
      await HarnessProfileStore.load(
        metadataHost,
        localPath(join(app.getPath('userData'), 'harness-profiles.json')),
      ),
      (profiles) => profiles.flush(),
    )
    await harnessProfileStore
      .importLegacyDefaults(terminalSessionRegistry.profileReferences())
      .catch((error) =>
        console.warn('[harness] legacy recovery profile import failed', error),
      )
    echoWorker = runtime.own(
      'echo worker',
      createWorkerClient<EchoWorkerProtocol>(workerPath('echo-worker.js'), 'hvir-echo'),
      (worker) => worker.dispose(),
    )
    gitWorker = runtime.own(
      'Git worker',
      createWorkerClient<GitWorkerProtocol>(
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
      ),
      (worker) => worker.dispose(),
    )
    ptySupervisor = runtime.own('PTY supervisor', new PtySupervisor(), (supervisor) =>
      supervisor.disposeAllAndWait(),
    )
    attentionBadge = runtime.own(
      'attention badge',
      new AttentionBadge((count) => {
        if (process.platform !== 'darwin' && process.platform !== 'linux') return false
        return app.setBadgeCount(count)
      }),
      (badge) => badge.clear(),
    )
    ptySupervisor.onSessionIdentity((info) => {
      if (info.identityStatus === 'identified' && info.harnessSessionId) {
        void terminalSessionRegistry
          ?.recordIdentity(info.id, info.harnessSessionId)
          .catch((error) =>
            console.error('[terminal] identity persistence failed', error),
          )
      }
      emitToRenderer(
        { id: info.ownerId, generation: info.ownerGeneration },
        'pty:identity',
        {
          id: info.id,
          harnessSessionId: info.harnessSessionId,
          identityStatus: info.identityStatus,
        },
      )
    })

    const withSshPresentation = <T>(owner: RendererOwner, operation: () => T): T => {
      if (!sshPrompter) throw new Error('SSH prompting is unavailable')
      return sshPrompter.runForOwner(owner, operation)
    }

    registerIpcHandlers({
      echoWorker,
      gitWorker,
      getProject: () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        return projectRegistry.active
      },
      getRegisteredWorkspaceRoot: (root) =>
        projectRegistry?.registeredWorkspaceRoot(root),
      getProjectState: () => {
        if (!projectRegistry) throw new Error('Project registry is unavailable')
        return projectRegistry.state()
      },
      listHosts: () => projectRegistry?.listHosts() ?? [],
      connectHost: (hostId, owner) =>
        withSshPresentation(owner, () =>
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
        ),
      disconnectHost: (hostId) =>
        serializeSession(async () => {
          if (!projectRegistry) throw new Error('Project registry is unavailable')
          if (projectRegistry.active.host.hostId === hostId) {
            await stopProjectWatch()
          }
          const roots = projectRegistry
            .state()
            .projects.filter((project) => project.registeredRoot.hostId === hostId)
            .flatMap((project) => project.workspaces.map((workspace) => workspace.root))
          await Promise.all(roots.map((root) => rendererScopes.revokeWorkspace(root)))
          return projectRegistry.disconnectHost(hostId)
        }),
      browseHost: (hostId, path, owner) =>
        withSshPresentation(owner, async () => {
          if (!projectRegistry) throw new Error('Project registry is unavailable')
          return projectRegistry.browseHost(hostId, path)
        }),
      openProject: (hostId, path, owner) =>
        withSshPresentation(owner, () =>
          serializeSession(async () => {
            if (!projectRegistry) throw new Error('Project registry is unavailable')
            await projectRegistry.open(hostId, path)
            await stopProjectWatch()
            const state = await refreshProjectWorkspaces(
              projectRegistry.active.projectId,
            ).catch((error) => {
              console.error('[workspace] discovery after registration failed', error)
              return projectRegistry!.state()
            })
            startProjectWatch(projectRegistry.active, emit)
            return state
          }),
        ),
      switchWorkspace: (projectId, workspaceId) =>
        serializeSession(async () => {
          if (!projectRegistry) throw new Error('Project registry is unavailable')
          const state = await projectRegistry.activate(projectId, workspaceId)
          await stopProjectWatch()
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
            projectRegistry.projectById(projectId)?.workspaces.map(({ root }) => root) ??
            []
          if (wasActive) await stopProjectWatch()
          try {
            await workspaceRefreshes.get(projectId)?.catch(() => undefined)
            workspaceRefreshes.delete(projectId)
            const refreshTimer = workspaceRefreshTimers.get(projectId)
            if (refreshTimer) clearTimeout(refreshTimer)
            workspaceRefreshTimers.delete(projectId)
            const state = await projectRegistry.closeProject(projectId)
            await Promise.all(
              closingRoots.flatMap((root) => [
                rendererScopes.revokeWorkspace(root),
                webPaneRoutes.closeWorkspace(root),
              ]),
            )
            return state
          } finally {
            if (
              wasActive &&
              projectRegistry.active.host.connectionState === 'connected'
            ) {
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
          if (workspace) {
            await Promise.all([
              rendererScopes.revokeWorkspace(workspace.root),
              webPaneRoutes.closeWorkspace(workspace.root),
            ])
          }
          if (wasActive) {
            await stopProjectWatch()
            startProjectWatch(projectRegistry.active, emit)
          }
          return state
        }),
      switchGitBranch: (root, branch) => requestGitBranchSwitch(root, branch),
      fetchGit: (root) => requestGitFetch(root),
      pullGit: (root) => requestGitPull(root),
      respondSshPrompt: (owner, id, answers) => sshPrompter?.respond(owner, id, answers),
      rendererResources: rendererScopes,
      rendererReady: (owner) => sshPrompter?.activateOwner(owner),
      ptySupervisor,
      terminalSessions: terminalSessionRegistry,
      harnessProfiles: harnessProfileStore,
      harnessProbes: harnessProbeManager,
      updateAttention: (owner, count) =>
        attentionBadge?.update(owner.id, count, owner.generation),
      updateWebPaneBindings: (owner, bindings) =>
        windowManager.updateWebPaneBindings(owner.id, bindings),
      updateWebPaneFullPage: (owner, paneId) =>
        windowManager.updateWebPaneFullPage(owner.id, paneId),
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
      if (runtime.isShuttingDown || BrowserWindow.getAllWindows().length === 0) return
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
  }

  function reopenWorkbench(): void {
    if (!projectRegistry || BrowserWindow.getAllWindows().length > 0) return
    if (projectRegistry.active.host.connectionState === 'connected') {
      startProjectWatch(projectRegistry.active, emitToWindows)
    }
    createWindow()
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
      await Promise.all([
        rendererScopes.revokeWorkspace(target.root),
        webPaneRoutes.closeWorkspace(target.root),
      ])
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
    if (runtime.isShuttingDown) return
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
      if (process.env['HVIR_SMOKE']) {
        htmlPreviews.register()
        const { runSmoke } = await import('./smoke')
        const code = await runSmoke({
          mode: process.env['HVIR_CAPACITY_SMOKE'] ? 'capacity' : 'workflow',
          createWindow,
          harnessProbeManager,
          htmlPreviews,
          rendererResources: rendererScopes,
          webPaneRoutes,
          updateWebPaneBindings: windowManager.updateWebPaneBindings,
          updateWebPaneFullPage: windowManager.updateWebPaneFullPage,
          openExternal: (url) => shell.openExternal(url),
        })
        app.exit(code)
        return
      }
      await runtime.start()
    })
    .catch((error: unknown) => {
      console.error('HVIR_STARTUP_FAIL', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    void runtime
      .reopen()
      .catch((error) => console.error('[window] failed to reopen workbench', error))
  })

  app.on('before-quit', (event) => {
    if (runtime.isShutdown) return
    event.preventDefault()
    if (runtime.isShuttingDown) return
    void runtime
      .shutdown()
      .catch((error) => console.error('[shutdown] workbench cleanup failed', error))
      .finally(() => app.quit())
  })

  async function suspendWorkbenchSessions(): Promise<void> {
    await stopProjectWatch()
    await settleWorkspaceRefreshes()
    const roots =
      projectRegistry
        ?.state()
        .projects.flatMap((project) =>
          project.workspaces.map((workspace) => workspace.root),
        ) ?? []
    await Promise.all(roots.map((root) => rendererScopes.revokeWorkspace(root)))
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
    if (workspacePoll) clearInterval(workspacePoll)
    workspacePoll = null
    for (const timer of workspaceRefreshTimers.values()) clearTimeout(timer)
    workspaceRefreshTimers.clear()
    await stopProjectWatch().catch((error) =>
      console.error('[shutdown] watcher cleanup failed', error),
    )
    await settleWorkspaceRefreshes()
  }

  async function settleWorkspaceRefreshes(): Promise<void> {
    await Promise.allSettled([...workspaceRefreshes.values()])
  }
}

createWorkbenchEntry()
