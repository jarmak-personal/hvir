/** Electron main-process entry and current application composition root. */

import { join } from 'node:path'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'

import { registerIpcHandlers } from './ipc'
import { createProjectCommands } from './ipc/project-commands'
import { GitMutationCoordinator } from './git/mutation-coordinator'
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
import { TerminalWorkspaceMoveCoordinator } from './terminal/terminal-workspace-move-coordinator'
import { RendererResourceScopes, type RendererOwner } from './renderer-resource-scopes'
import { createElectronWindowManager } from './window/electron-window-manager'
import { WorkbenchRuntime } from './workbench-runtime'
import {
  GIT_CHANGED_FILE_COUNT_TYPE,
  GIT_FETCH_TYPE,
  GIT_PRUNE_WORKTREES_TYPE,
  GIT_PULL_TYPE,
  GIT_SWITCH_BRANCH_TYPE,
  GIT_WORKTREES_TYPE,
  localPath,
  LOCAL_HOST_ID,
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
    const gitMutations = new GitMutationCoordinator({
      registry: projectRegistry,
      worker: {
        pruneWorktrees: (root) => gitWorker!.request(GIT_PRUNE_WORKTREES_TYPE, { root }),
        switchBranch: (root, branch, relatedWorktreeRoots) =>
          gitWorker!.request(GIT_SWITCH_BRANCH_TYPE, {
            root,
            branch,
            relatedWorktreeRoots,
          }),
        fetch: (root) => gitWorker!.request(GIT_FETCH_TYPE, { root }),
        pull: (root, relatedWorktreeRoots) =>
          gitWorker!.request(GIT_PULL_TYPE, { root, relatedWorktreeRoots }),
      },
      workspaces: workspaceCoordinator,
      authorizations: gitMutationAuthorizations,
      cleanup: {
        forgetWorkspaceSessions: async (root) => {
          await Promise.all(
            terminalSessionRegistry!
              .list(root)
              .map((session) => terminalSessionRegistry!.forget(root, session.id)),
          )
        },
        revokeWorkspace: (root) => rendererScopes.revokeWorkspace(root),
        closeWorkspace: (root) => webPaneRoutes.closeWorkspace(root),
        clearHtmlPreviews: () => htmlPreviews.clear(),
      },
      onError: (message, error) => console.error(message, error),
    })
    ptySupervisor = runtime.own('PTY supervisor', new PtySupervisor(), (supervisor) =>
      supervisor.disposeAllAndWait(),
    )
    const terminalMoves = new TerminalWorkspaceMoveCoordinator({
      projects: projectRegistry,
      workspaces: workspaceCoordinator,
      sessions: terminalSessionRegistry,
      ptys: ptySupervisor,
      resources: rendererScopes,
      webPanes: webPaneRoutes,
      onError: (message, error) => console.error(message, error),
    })
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
    const projectCommands = createProjectCommands({
      projects: projectCoordinator,
      workspaces: workspaceCoordinator,
      git: gitMutations,
      withSshPresentation,
    })

    runtime.own(
      'IPC authority router',
      registerIpcHandlers({
        echoWorker,
        gitWorker,
        getProject: () => {
          if (!projectRegistry) throw new Error('Project registry is unavailable')
          return projectRegistry.active
        },
        getHost: (hostId) => projectRegistry?.hostById(hostId),
        connectedHosts: () => projectRegistry?.connectedHosts() ?? [],
        getRegisteredWorkspaceRoot: (root) =>
          projectRegistry?.registeredWorkspaceRoot(root),
        getProjectState: () => {
          if (!projectRegistry) throw new Error('Project registry is unavailable')
          return projectRegistry.state()
        },
        listHosts: () => projectRegistry?.listHosts() ?? [],
        ...projectCommands,
        respondSshPrompt: (owner, id, answers) =>
          sshPrompter?.respond(owner, id, answers),
        rendererResources: rendererScopes,
        rendererReady: (owner) => sshPrompter?.activateOwner(owner),
        ptySupervisor,
        terminalSessions: terminalSessionRegistry,
        terminalMoves,
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
      }),
      (router) => router.dispose(),
    )
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

  function projectRootArgument(): string | undefined {
    const fromFlag = process.argv.find((arg) => arg.startsWith('--project-root='))
    return fromFlag?.slice('--project-root='.length) || process.env.HVIR_PROJECT_ROOT
  }

  void app
    .whenReady()
    .then(async () => {
      if (process.env['HVIR_SMOKE']) {
        const { runElectronSmokeScenario } = await import('./smoke/scenarios')
        const code = await runElectronSmokeScenario({
          scenario: process.env['HVIR_SMOKE_SCENARIO'],
          projectRoot: localPath(projectRootArgument() ?? process.cwd()),
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
