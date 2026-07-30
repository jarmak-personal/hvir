import { webContents, type BrowserWindow } from 'electron'

import { dispatchWorkerHostCall } from '../git/worker-host-broker'
import { createFilenameSearchCoordinator } from '../filename-search'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import { harnessProviderCatalog } from '../harness/harness-provider'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import { registerIpcHandlers } from '../ipc'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import { createWorkerClient, workerPath } from '../worker-host'
import { createWorkspaceCleanup } from '../workspace-cleanup'
import { SmokeCleanup } from './cleanup'
import { createSmokeImagePasteFallback } from './image-paste-fallback'
import { verifyDiagnosticRestart } from './diagnostic-report-restart'
import { verifyDevelopmentPerformanceMode } from './development-performance'
import { verifyGitWorkflow } from './git-workflow'
import { verifyPlatformContracts } from './platform-contracts'
import {
  verifyRendererLifecycleCleanup,
  verifyRendererRolloverRecovery,
} from './renderer-lifecycle'
import { verifyFocusedViewer } from './viewer-position'
import { verifyViewerContent } from './viewer-content'
import { verifyWorkbenchHealthFault } from './workbench-health'
import { verifyUnresponsiveRendererRecovery } from './renderer-recovery'
import type { ElectronSmokeMode } from './scenario-selection.mts'
import { createTerminalMoveSmokeHarness, verifyTerminalMoveSmoke } from './terminal-move'
import { createSmokeTerminalSessionStore } from './terminal-session-store'
import {
  verifyLegacyTerminalPresentation,
  verifyTerminalPresentationLifecycle,
} from './terminal-presentation'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyTerminalReconnectRemount } from './terminal-renderer-lifecycle'
import { verifyWorkspaceCloseSmoke, workspaceCloseSmokeCommands } from './workspace-close'
import {
  capacityRecoverySessions,
  runCapacityLoadSmoke,
  runCapacityRecoverySmoke,
} from './capacity'
import {
  ECHO_REQUEST_TYPE,
  MAX_PROJECT_WATCH_INTERESTS,
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
} from '../../shared'

export interface ElectronSmokeDependencies {
  readonly mode: ElectronSmokeMode
  readonly projectRoot: HostPath
  readonly createWindow: (
    discardRendererResources?: (ownerId: number) => void,
  ) => BrowserWindow
  readonly harnessProbeManager: HarnessProbeManager
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly rendererResources: RendererResourceScopes
  readonly diagnostics: import('../ipc/deps').IpcDeps['diagnostics']
  readonly runtimeDiagnostics: RuntimeDiagnostics
  readonly webPaneRoutes: WebPaneRouteRegistry
  readonly rendererReady: (
    owner: import('../renderer-resource-scopes').RendererOwner,
    reportedGeneration: number,
  ) => boolean
  readonly reloadUnresponsiveRenderer: (
    owner: import('../renderer-resource-scopes').RendererOwner,
  ) => boolean
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
    projectRoot,
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
    (call) => dispatchWorkerHostCall(call, { host, root: projectRoot }),
  )
  const filenameSearch = createFilenameSearchCoordinator(git)
  const host = new LocalHost()
  const supervisor = new PtySupervisor()
  let smokeWindow: BrowserWindow | undefined
  let discardedRendererGenerations = 0
  let stopSmokeWatch: Disposer | undefined
  const smokeRoot = projectRoot
  const smokeCloseableRoot = joinHostPath(smokeRoot, '.hvir-smoke-closed-project')
  const smokeWebSwitchRoot = joinHostPath(smokeRoot, 'docs')
  const cleanup = new SmokeCleanup()
  cleanup.defer('echo worker', () => worker.dispose())
  cleanup.defer('Git worker', () => git.dispose())
  cleanup.defer('filename search', () => filenameSearch.dispose())
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
            closed: false,
            missing,
            // The platform-only group does not acquire unrelated Git-worker work.
            repository: mode !== 'platform-contracts' && mode !== 'renderer-recovery',
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
            closed: false,
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
    if (mode === 'workflow') {
      const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
      if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
      if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
      console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)
    }
    // Exercise the real renderer → main → worker path.
    await host.connect()
    await host.exec('rm', ['-f', '--', harnessProfilesPath.path])
    const liveReloadBefore = `${Array.from({ length: 240 }, (_, index) => `line ${index}`).join('\n')}\n`
    await host.writeFile(liveReloadPath, liveReloadBefore)
    if (mode === 'workflow' || mode === 'viewer-position') {
      await host.writeFile(
        viewerPositionPath,
        Array.from(
          { length: 80 },
          (_, index) => `## Position ${index + 1}\n\nParagraph ${index + 1}\n`,
        ).join('\n'),
      )
    }
    if (mode === 'workflow' || mode === 'viewer-content') {
      await host.writeFile(
        largeJsonPath,
        JSON.stringify(
          Array.from({ length: 50_000 }, (_, index) => ({
            id: index,
            value: `item-${index}`,
          })),
        ),
      )
    }
    if (mode === 'workflow' || mode === 'viewer-position' || mode === 'viewer-content') {
      await host.writeFile(
        largeTextPath,
        `${'large file responsiveness fixture 0123456789\n'.repeat(135_000)}end\n`,
      )
    }
    const emit: EmitSmokeEvent = (channel, payload) => {
      if (smokeWindow && !smokeWindow.isDestroyed())
        smokeWindow.webContents.send(channel, payload)
    }
    const smokeTerminalSessionHarness = createSmokeTerminalSessionStore(smokeRoot)
    const smokeTerminalSessions = smokeTerminalSessionHarness.store
    const smokeHarnessProfiles = await HarnessProfileStore.load(host, harnessProfilesPath)
    let smokeIpcProjectState = smokeProjectState()
    const openedFolderSelections: Array<{ hostId: string; path: string }> = []
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
    const workspaceCloseCommands = workspaceCloseSmokeCommands({
      host,
      getState: () => smokeIpcProjectState,
      setState: (state) => {
        smokeIpcProjectState = state
      },
      cleanup: createWorkspaceCleanup({
        ptys: supervisor,
        resources: rendererResources,
        sessions: smokeTerminalSessions,
        webPanes: webPaneRoutes,
      }),
    })
    const ipcRouter = registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      filenameSearch,
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
      openProject: (hostId, path) => {
        openedFolderSelections.push({ hostId, path })
        return Promise.resolve(smokeProjectState())
      },
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
      planWorkspaceClose: workspaceCloseCommands.planWorkspaceClose,
      closeWorkspace: workspaceCloseCommands.closeWorkspace,
      reopenWorkspace: workspaceCloseCommands.reopenWorkspace,
      acknowledgeWorkspace: () => Promise.resolve(smokeProjectState()),
      switchGitBranch: async (_root, branch) => {
        const result = await host.exec('git', [
          '-C',
          smokeRoot.path,
          'switch',
          '--no-guess',
          branch,
        ])
        if (result.code !== 0) throw new Error(result.stderr)
        return smokeProjectState()
      },
      fetchGit: () => Promise.resolve(smokeProjectState()),
      pullGit: () => Promise.resolve(smokeProjectState()),
      respondSshPrompt: () => undefined,
      rendererResources,
      rendererReady: dependencies.rendererReady,
      getWorkbenchHealth: () => ({
        version: 1,
        evidence: 'memory-only',
        items: [],
        dropped: 0,
      }),
      acknowledgeWorkbenchHealth: () => ({
        version: 1,
        evidence: 'memory-only',
        items: [],
        dropped: 0,
      }),
      diagnostics: dependencies.diagnostics,
      recordIpcContractDiagnostic: () => undefined,
      recordRenderContainment: () => undefined,
      ptySupervisor: supervisor,
      terminalSessions: smokeTerminalSessions,
      terminalMoves: terminalMoveSmoke.coordinator,
      harnessProfiles: smokeHarnessProfiles,
      harnessProbes: harnessProbeManager,
      remoteImagePaste: createSmokeImagePasteFallback(supervisor),
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
    if (mode === 'workflow') {
      const result = await host.exec('/bin/echo', ['hvir'])
      if (result.stdout.trim() !== 'hvir') {
        throw new Error(`exec mismatch: ${result.stdout}`)
      }
      console.log('[smoke] LocalHost.exec OK')
      // Prove host-qualified read works too.
      await host.stat(smokeRoot)
      console.log('[smoke] LocalHost.stat OK')
    }
    const win = createWindow(() => {
      discardedRendererGenerations++
    })
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
    if (await verifyDevelopmentPerformanceMode(win, mode)) return 0
    if (mode === 'renderer-recovery') {
      const result = await verifyUnresponsiveRendererRecovery({
        win,
        resources: rendererResources,
        diagnostics: dependencies.runtimeDiagnostics,
        supervisor,
        reloadUnresponsiveRenderer: dependencies.reloadUnresponsiveRenderer,
      })
      if (discardedRendererGenerations !== 1) {
        throw new Error(
          `renderer recovery discarded resources ${discardedRendererGenerations} times`,
        )
      }
      console.log(`[smoke] renderer recovery OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (await verifyDiagnosticRestart(win, dependencies.runtimeDiagnostics)) return 0
    if (mode === 'workflow') {
      const health = await verifyWorkbenchHealthFault(win, () => {
        const owner = rendererResources.currentOwner(win.webContents.id)
        if (!dependencies.rendererReady(owner, owner.generation)) {
          throw new Error('window manager rejected smoke renderer readiness')
        }
      })
      console.log(`[smoke] workbench health fault injection OK (${health})`)
    }
    if (mode === 'workflow' || mode === 'platform-contracts') {
      const result = await verifyPlatformContracts({
        htmlPreviews,
        supervisor,
        win,
      })
      console.log(`[smoke] platform contracts OK (${result})`)
      if (mode === 'platform-contracts') {
        console.log('HVIR_SMOKE_OK')
        return 0
      }
      const presentation = await verifyLegacyTerminalPresentation(win)
      console.log(`[smoke] terminal presentation OK (${presentation})`)
    }
    if (mode === 'workflow') {
      const workspaceCloseStatus = await verifyWorkspaceCloseSmoke({
        win,
        host,
        supervisor,
        resources: rendererResources,
        routes: webPaneRoutes,
        activeRoot: smokeRoot,
        closeRoot: smokeWebSwitchRoot,
        getState: () => smokeIpcProjectState,
        setState: (state) => (smokeIpcProjectState = state),
        emitState: (state) => emit('project:state', state),
        recovery: {
          add: smokeTerminalSessionHarness.add,
          has: smokeTerminalSessionHarness.has,
        },
      })
      console.log(`[smoke] workspace close OK (${workspaceCloseStatus})`)
    }
    if (mode === 'viewer-position') {
      const result = await verifyFocusedViewer(win, liveReloadPath, viewerPositionPath)
      console.log(`[smoke] source/diff viewer positions OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'viewer-content') {
      const result = await verifyViewerContent({
        win,
        host,
        liveReloadPath,
        largeJsonPath,
        largeTextPath,
        liveReloadBefore,
      })
      console.log(`[smoke] viewer content OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'git-workflow') {
      const result = await verifyGitWorkflow({
        win,
        host,
        root: smokeRoot,
        untrackedPath: liveReloadPath,
      })
      console.log(`[smoke] Git workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'terminal-presentation') {
      const presentation = await verifyTerminalPresentationLifecycle(
        win,
        supervisor,
        smokeRoot,
      )
      console.log(`[smoke] terminal presentation lifecycle OK (${presentation})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'terminal-lifecycle') {
      const launchStatus = await ensureExplicitBareShellLaunch(win, supervisor)
      const reconnectStatus = await withTimeout(
        verifyTerminalReconnectRemount({
          win,
          supervisor,
          resources: rendererResources,
          root: smokeRoot,
          connectedState: smokeProjectState('connected'),
          disconnectedState: smokeProjectState('disconnected'),
          emitProjectState: (state) => {
            smokeIpcProjectState = state
            emit('project:state', state)
          },
        }),
        'terminal reconnect lifecycle timed out',
      )
      const recoveryStatus = await verifyRendererRolloverRecovery({
        win,
        supervisor,
        root: smokeRoot,
        providerId: defaultHarnessProviderId,
        setRecoverySessions: (sessions) => {
          smokeTerminalSessionHarness.set(sessions)
        },
      })
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
        '[smoke] terminal renderer lifecycle OK (' +
          [launchStatus, reconnectStatus, recoveryStatus].join(' · ') +
          ' · renderer destruction cleanup)',
      )
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'capacity') {
      await runCapacityLoadSmoke(win, supervisor, host, liveReloadPath)
      smokeTerminalSessionHarness.set(
        capacityRecoverySessions(supervisor, defaultHarnessProviderId),
      )
      // The load and synthetic recovery checks are separate capacity contracts.
      // End the load fixtures so rollover preservation does not inflate recovery counts.
      supervisor.disposeSessions()
      await runCapacityRecoverySmoke(win, supervisor)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
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
            preview
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
      !profileSmoke.preview.args.includes(smokeRoot.path) ||
      !profileSmoke.preview.command.includes("HVIR_PROFILE_SMOKE='structured'")
    ) {
      throw new Error('structured Custom profile did not preserve preview semantics')
    }
    console.log('[smoke] structured profile catalog + preview OK')

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
              closed: false,
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

    const terminalMoveStatus = await verifyTerminalMoveSmoke({
      win,
      supervisor,
      harness: terminalMoveSmoke,
      emitState: (state) => emit('project:state', state),
    })
    console.log(`[smoke] live terminal worktree move OK (${terminalMoveStatus})`)

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

    const railNavigationStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const railButtons = [...document.querySelectorAll('.rail-nav button')];
          const byLabel = (label) =>
            railButtons.find((node) => node.textContent?.trim().startsWith(label));
          const files = byLabel('Files');
          const harness = byLabel('Harness');
          const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
            .find((node) => node.querySelector(':scope > .directory-row')
              ?.getAttribute('title')?.endsWith('/src'));
          if (!files || !harness || !directory) {
            return reject(new Error('stable rail navigation controls missing'));
          }
          const directoryRow = directory.querySelector(':scope > .directory-row');
          if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
          const tabsBefore = document.querySelectorAll('.viewer-tab').length;
          harness.click();
          const waitForHarness = () => {
            const placeholder = document.querySelector('.harness-placeholder');
            if (
              harness.disabled ||
              !harness.classList.contains('active') ||
              harness.getAttribute('aria-current') !== 'page' ||
              !placeholder ||
              placeholder.hidden ||
              !placeholder.textContent?.includes('Coming soon')
            ) {
              if (Date.now() > deadline) {
                return reject(new Error('Harness coming-soon route is not interactive'));
              }
              return setTimeout(waitForHarness, 25);
            }
            files.click();
            const waitForFiles = () => {
              const currentFiles = [...document.querySelectorAll('.rail-nav button')]
                .find((node) => node.textContent?.trim().startsWith('Files'));
              const ready = directory.isConnected &&
                directoryRow?.getAttribute('aria-expanded') === 'true' &&
                document.querySelectorAll('.viewer-tab').length === tabsBefore &&
                currentFiles?.classList.contains('active') &&
                !harness.disabled;
              if (ready) {
                return resolve(
                  'stable tabs · Files state preserved · Harness coming soon'
                );
              }
              if (Date.now() > deadline) {
                return reject(new Error('Files rail state did not restore after Harness'));
              }
              setTimeout(waitForFiles, 25);
            };
            waitForFiles();
          };
          waitForHarness();
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
        const focusedBefore = document.activeElement;
        projectMain?.focus({ focusVisible: true });
        if (!projectMain || getComputedStyle(projectMain).boxShadow === 'none') {
          return reject(new Error(
            'project tab focus ring is missing: before=' + focusedBefore?.className +
            ' active=' + document.activeElement?.className +
            ' focusVisible=' + projectMain?.matches(':focus-visible')
          ));
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
            const input = document.querySelector('.folder-path-form input');
            const selected = document.querySelector('.folder-selection code')?.textContent || '';
            const selectedRow = document.querySelector('.folder-browser .directory-row.selected');
            const browser = document.querySelector('.folder-browser');
            const show = [...document.querySelectorAll('.project-dialog button')]
              .find((node) => node.textContent?.trim() === 'Show in tree');
            const use = [...document.querySelectorAll('.project-dialog button')]
              .find((node) => node.textContent?.trim() === 'Use this folder');
            const initialVisible = browser && selectedRow && (() => {
              const bounds = browser.getBoundingClientRect();
              const row = selectedRow.getBoundingClientRect();
              return row.top >= bounds.top && row.bottom <= bounds.bottom;
            })();
            if (input && input.value && selected === input.value && initialVisible && show && use) {
              if (input.form !== show.closest('form') || input.form !== use.closest('form')) {
                return reject(new Error('folder actions are not adjacent to the path field'));
              }
              const setPath = (value) => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
              };
              setPath('/tmp/hvir-smoke.missing');
              input.form.requestSubmit();
              const waitForInvalid = () => {
                const error = document.querySelector('.dialog-error')?.textContent || '';
                if (error.includes('Folder not found') && use.disabled && document.activeElement === input) {
                  const target = ${JSON.stringify(`${smokeRoot.path}/docs`)};
                  setPath(target);
                  browser.scrollTop = browser.scrollHeight;
                  show.click();
                  const waitForReveal = () => {
                    const row = [...document.querySelectorAll('.folder-browser .directory-row')]
                      .find((node) => node.getAttribute('title') === target);
                    const bounds = browser.getBoundingClientRect();
                    const rect = row?.getBoundingClientRect();
                    const visible = rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
                    if (row?.classList.contains('selected') && visible && !use.disabled && document.activeElement === input) {
                      use.click();
                      const waitForClose = () => {
                        if (!document.querySelector('.project-dialog')) return resolve('Local→invalid→reveal→use ' + target);
                        if (Date.now() > deadline) return reject(new Error('folder confirmation did not close'));
                        setTimeout(waitForClose, 25);
                      };
                      return waitForClose();
                    }
                    if (Date.now() > deadline) return reject(new Error('typed folder was not revealed'));
                    setTimeout(waitForReveal, 25);
                  };
                  return waitForReveal();
                }
                if (Date.now() > deadline) return reject(new Error('invalid folder remained confirmable'));
                setTimeout(waitForInvalid, 25);
              };
              return waitForInvalid();
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
    if (
      openedFolderSelections.length !== 1 ||
      openedFolderSelections[0]?.hostId !== 'local' ||
      openedFolderSelections[0]?.path !== `${smokeRoot.path}/docs`
    ) {
      throw new Error(
        `folder selection opened an unexpected target: ${JSON.stringify(openedFolderSelections)}`,
      )
    }
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
                      return resolve('terminal PTY split + keyboard divider');
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
          terminalSplit();
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
            const active = dialog?.querySelector('[aria-current="page"]')?.textContent?.trim();
            const profileEditor = dialog?.querySelector('.settings-profile-editor');
            if (!dialog || !heading || active !== 'Harnesses')
              return reject(new Error('configure harnesses did not target its section'));
            if (!profileEditor || profileEditor.scrollHeight > profileEditor.clientHeight + 1)
              return reject(new Error('default harness profile requires scrolling'));
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
              closed: false,
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

    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    await cleanup.run()
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
