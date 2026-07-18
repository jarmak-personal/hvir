/** Electron main-process entry and current application composition root. */

import { join } from 'node:path'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { GitMutationAuthorization } from './git/mutation-authorization'
import { GitWorkerHostRouter } from './git/worker-host-router'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { createWorkerClient, workerPath, type WorkerClient } from './worker-host'
import { ProjectRegistry, RendererSshPrompter } from './project-registry'
import { ProjectCoordinator } from './project-coordinator'
import { PtySupervisor } from './pty/pty-supervisor'
import { AttentionBadge } from './attention-badge'
import { HarnessProfileStore } from './harness/harness-profile-store'
import { HarnessProbeManager } from './harness/harness-probe'
import { ProjectWatchController } from './project-watch'
import { WorkspaceCoordinator } from './workspace-coordinator'
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
  const gitMutationAuthorizations = runtime.own(
    'Git mutation authorizations',
    new GitMutationAuthorization(),
    (authorizations) => authorizations.dispose(),
  )

  let echoWorker: WorkerClient<EchoWorkerProtocol> | null = null
  let gitWorker: WorkerClient<GitWorkerProtocol> | null = null
  let projectRegistry: ProjectRegistry | null = null
  let sshPrompter: RendererSshPrompter | null = null
  let ptySupervisor: PtySupervisor | null = null
  let terminalSessionRegistry: TerminalSessionRegistry | null = null
  let harnessProfileStore: HarnessProfileStore | null = null
  let attentionBadge: AttentionBadge | null = null
  let workspaceCoordinator: WorkspaceCoordinator | null = null
  let projectCoordinator: ProjectCoordinator | null = null

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
    const gitHostRouter = new GitWorkerHostRouter({
      authority: projectRegistry,
      authorizations: gitMutationAuthorizations,
    })
    gitWorker = runtime.own(
      'Git worker',
      createWorkerClient<GitWorkerProtocol>(
        workerPath('git-worker.js'),
        'hvir-git',
        (call) => gitHostRouter.route(call),
      ),
      (worker) => worker.dispose(),
    )
    workspaceCoordinator = runtime.own(
      'workspace coordinator',
      new WorkspaceCoordinator({
        registry: projectRegistry,
        discovery: {
          discover: (root) => gitWorker!.request(GIT_WORKTREES_TYPE, { root }),
          changedFileCount: (root, relatedWorktreeRoots) =>
            gitWorker!.request(GIT_CHANGED_FILE_COUNT_TYPE, {
              root,
              relatedWorktreeRoots,
            }),
        },
        emitWatch: (event) => emit('project:watch', event),
        createWatch: (target, callbacks) => new ProjectWatchController(target, callbacks),
        shouldPoll: () =>
          !runtime.isShuttingDown && BrowserWindow.getAllWindows().length > 0,
        onError: (message, error) => console.error(message, error),
      }),
      (coordinator) => coordinator.dispose(),
    )
    projectCoordinator = new ProjectCoordinator({
      registry: projectRegistry,
      workspaces: workspaceCoordinator,
      cleanup: {
        revokeWorkspace: (root) => rendererScopes.revokeWorkspace(root),
        closeWorkspace: (root) => webPaneRoutes.closeWorkspace(root),
        forgetWorkspaceSessions: async (root) => {
          await Promise.all(
            terminalSessionRegistry!
              .list(root)
              .map((session) => terminalSessionRegistry!.forget(root, session.id)),
          )
        },
      },
      onError: (message, error) => console.error(message, error),
    })
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
        withSshPresentation(owner, () => {
          if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
          return projectCoordinator.connectHost(hostId)
        }),
      disconnectHost: (hostId) => {
        if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
        return projectCoordinator.disconnectHost(hostId)
      },
      browseHost: (hostId, path, owner) =>
        withSshPresentation(owner, async () => {
          if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
          return projectCoordinator.browseHost(hostId, path)
        }),
      openProject: (hostId, path, owner) =>
        withSshPresentation(owner, () => {
          if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
          return projectCoordinator.openProject(hostId, path)
        }),
      switchWorkspace: (projectId, workspaceId) => {
        if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
        return projectCoordinator.switchWorkspace(projectId, workspaceId)
      },
      refreshProject: (projectId) => {
        if (!workspaceCoordinator) throw new Error('Workspace coordinator is unavailable')
        return workspaceCoordinator.refresh(projectId)
      },
      updateWatchInterests: (paths) => {
        if (!workspaceCoordinator) throw new Error('Workspace coordinator is unavailable')
        return workspaceCoordinator.updateWatchInterests(paths)
      },
      closeProject: (projectId) => {
        if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
        return projectCoordinator.closeProject(projectId)
      },
      pruneWorktrees: (projectId) => requestProjectWorktreePrune(projectId),
      dismissWorkspace: (projectId, workspaceId) => {
        if (!projectCoordinator) throw new Error('Project coordinator is unavailable')
        return projectCoordinator.dismissWorkspace(projectId, workspaceId)
      },
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
      void workspaceCoordinator
        .replaceWatch(projectRegistry.active)
        .then(() => workspaceCoordinator?.refresh(projectRegistry!.active.projectId))
        .catch((error) => console.error('[workspace] initial discovery failed', error))
    }
    workspaceCoordinator.startPolling()
  }

  function reopenWorkbench(): void {
    if (!projectRegistry || BrowserWindow.getAllWindows().length > 0) return
    if (projectRegistry.active.host.connectionState === 'connected') {
      void workspaceCoordinator
        ?.replaceWatch(projectRegistry.active)
        .catch((error) => console.error('[workspace] watch reopen failed', error))
    }
    createWindow()
  }

  function requestProjectWorktreePrune(projectId: string): Promise<ProjectState> {
    const coordinator = workspaceCoordinator
    if (!coordinator) throw new Error('Workspace pruning is unavailable')
    coordinator.invalidateProject(projectId)
    const settled = coordinator.settleProject(projectId)
    return coordinator.coalesceProjectOperation(projectId, async () => {
      await settled
      return pruneProjectWorktrees(projectId)
    })
  }

  async function pruneProjectWorktrees(projectId: string): Promise<ProjectState> {
    const registry = projectRegistry
    const worker = gitWorker
    const sessions = terminalSessionRegistry
    if (!registry || !worker || !sessions) {
      throw new Error('Workspace pruning is unavailable')
    }
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

    const grant = gitMutationAuthorizations.grant({
      kind: 'worktree-prune',
      projectId,
      root: project.registeredRoot,
    })
    let discovery: WorktreeDiscovery
    try {
      discovery = await worker.request(GIT_PRUNE_WORKTREES_TYPE, {
        root: project.registeredRoot,
      })
    } finally {
      grant.revoke()
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
      await workspaceCoordinator?.stopWatch()
      htmlPreviews.clear()
      await workspaceCoordinator?.replaceWatch(registry.active)
    }
    return registry.state()
  }

  function requestGitBranchSwitch(root: HostPath, branch: string): Promise<ProjectState> {
    if (!workspaceCoordinator) throw new Error('Branch switching is unavailable')
    return workspaceCoordinator.serialize(async () => {
      const registry = projectRegistry
      const worker = gitWorker
      const coordinator = workspaceCoordinator
      if (!registry || !worker || !coordinator) {
        throw new Error('Branch switching is unavailable')
      }
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
      coordinator.invalidateProject(projectId)
      await coordinator.settleProject(projectId)
      const grant = gitMutationAuthorizations.grant({
        kind: 'branch-switch',
        projectId,
        root,
        target: branch,
      })
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
        grant.revoke()
      }
      try {
        return await coordinator.refresh(projectId)
      } catch (error) {
        console.error('[git] workspace refresh after branch switch failed', error)
        coordinator.scheduleRefresh(projectId)
        return registry.state()
      }
    })
  }

  function requestGitFetch(root: HostPath): Promise<ProjectState> {
    if (!workspaceCoordinator) throw new Error('Git fetch is unavailable')
    return workspaceCoordinator.serialize(async () => {
      const registry = projectRegistry
      const worker = gitWorker
      if (!registry || !worker) throw new Error('Git fetch is unavailable')
      assertActiveGitWorkspace(root, registry, 'fetching')
      const grant = gitMutationAuthorizations.grant({
        kind: 'fetch',
        projectId: registry.active.projectId,
        root,
      })
      try {
        await worker.request(GIT_FETCH_TYPE, { root })
      } finally {
        grant.revoke()
      }
      return registry.state()
    })
  }

  function requestGitPull(root: HostPath): Promise<ProjectState> {
    if (!workspaceCoordinator) throw new Error('Git pull is unavailable')
    return workspaceCoordinator.serialize(async () => {
      const registry = projectRegistry
      const worker = gitWorker
      const coordinator = workspaceCoordinator
      if (!registry || !worker || !coordinator) throw new Error('Git pull is unavailable')
      assertActiveGitWorkspace(root, registry, 'pulling')
      const projectId = registry.active.projectId
      coordinator.invalidateProject(projectId)
      await coordinator.settleProject(projectId)
      const grant = gitMutationAuthorizations.grant({
        kind: 'pull',
        projectId,
        root,
      })
      try {
        const relatedWorktreeRoots =
          registry
            .projectById(projectId)
            ?.workspaces.filter((workspace) => !workspace.missing)
            .map((workspace) => workspace.root) ?? []
        await worker.request(GIT_PULL_TYPE, { root, relatedWorktreeRoots })
      } finally {
        grant.revoke()
      }
      try {
        return await coordinator.refresh(projectId)
      } catch (error) {
        console.error('[git] workspace refresh after pull failed', error)
        coordinator.scheduleRefresh(projectId)
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
    await workspaceCoordinator?.stopWatch()
    await workspaceCoordinator?.settle()
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
    workspaceCoordinator?.stopPolling()
    await workspaceCoordinator
      ?.stopWatch()
      .catch((error) => console.error('[shutdown] watcher cleanup failed', error))
    await workspaceCoordinator?.settle()
  }
}

createWorkbenchEntry()
