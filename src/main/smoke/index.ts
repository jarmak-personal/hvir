import type { BrowserWindow } from 'electron'

import { dispatchWorkerHostCall } from '../git/worker-host-broker'
import { createFilenameSearchCoordinator } from '../filename-search'
import { createProjectFileOperationCoordinator } from '../project-file-operations'
import { ProjectFolderPickerCoordinator } from '../project-folder-picker'
import { createDocumentReviewRuntime } from '../document-review'
import { HarnessProfileStore } from '../harness/harness-profile-store'
import {
  HarnessProviderRegistry,
  harnessProviderCatalog,
  harnessProviders,
} from '../harness/harness-provider'
import { HarnessUsageDemandController } from '../harness/harness-usage-demand-controller'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import { sendRendererEvent } from '../renderer-event-delivery'
import { registerIpcHandlers } from '../ipc'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import { LocalHost } from '../project-host'
import { PtySupervisor } from '../pty/pty-supervisor'
import { SessionsObservationPort } from '../sessions/sessions-observation-port'
import { SessionsUsageObservationPort } from '../sessions/sessions-usage-observation-port'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import { createWorkerClient, workerPath } from '../worker-host'
import { createWorkspaceCleanup } from '../workspace-cleanup'
import { SmokeCleanup } from './cleanup'
import {
  reportSmokeFailureEvidence,
  smokeCleanupResource,
  type SmokeFailureCheckpoint,
  type SmokeFailurePhase,
  type SmokeOwnedResourceEvidence,
} from './failure-evidence.mts'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'
import { createSmokeImagePasteFallback } from './image-paste-fallback'
import { verifyDiagnosticRestart } from './diagnostic-report-restart'
import { verifyDevelopmentPerformanceMode } from './development-performance'
import { verifyDocumentReviewWorkflow } from './document-review'
import { verifyGitWorkflow } from './git-workflow'
import {
  verifyCompactHarnessSettings,
  verifyHarnessManualProfilePointerActivation,
} from './harness-settings-layout'
import { captureHarnessSettingsVisuals } from './harness-settings-visual'
import { verifyPlatformContracts } from './platform-contracts'
import {
  verifyTerminalRendererDestruction,
  verifyRendererRolloverRecovery,
} from './renderer-lifecycle'
import { verifyRendererAuthorityLifecycle } from './renderer-authority'
import { createExternalMoveSmokeControl } from './external-file-move'
import {
  createRemoteProjectFileSmokeHost,
  verifyProjectFileOperationsSmoke,
} from './project-file-operations'
import { verifyFocusedViewer } from './viewer-position'
import { verifyViewerContent } from './viewer-content'
import { verifyWorkbenchHealthFault } from './workbench-health'
import { verifyRendererProcessRecovery } from './renderer-recovery'
import { verifySessionsProjectionSmoke } from './sessions-projection'
import { sessionsUsageSmokeProvider } from './sessions-usage-provider'
import type { ElectronSmokeMode } from './scenario-selection.mts'
import { createTerminalMoveSmokeHarness, verifyTerminalMoveSmoke } from './terminal-move'
import { createSmokeTerminalSessionStore } from './terminal-session-store'
import { verifyTerminalPresentationLifecycle } from './terminal-presentation'
import { verifyLegacyTerminalPresentation } from './terminal-legacy-presentation'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyTerminalReconnectRemount } from './terminal-renderer-lifecycle'
import { verifyWebPaneWorkflow } from './web-pane'
import { verifyWorkspaceRemoteWorkflow } from './workspace-remote'
import { workspaceCloseSmokeCommands } from './workspace-close'
import {
  capacityRecoverySessions,
  runCapacityLoadSmoke,
  runCapacityRecoverySmoke,
} from './capacity'
import {
  ECHO_REQUEST_TYPE,
  MAX_PROJECT_WATCH_INTERESTS,
  asHostId,
  basenameHostPath,
  dirnameHostPath,
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
  readonly updateWebPaneBindings: (ownerId: number, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (ownerId: number, paneId?: string) => void
  readonly openExternal: (url: string) => Promise<void>
  readonly interruptionCheckpoint: SmokeInterruptionCheckpoint
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
    interruptionCheckpoint,
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
  const smokeRoot = projectRoot
  const smokeTrashRecoveryRoot = joinHostPath(
    dirnameHostPath(smokeRoot),
    `.hvir-smoke-trash-recovery-${process.pid}-${basenameHostPath(smokeRoot)}`,
  )
  let smokeTrashSequence = 0
  let smokeTrashFailurePath: HostPath | undefined
  const smokeRecoveredPaths = new Set<HostPath>()
  const host = new LocalHost({
    trashItem: async (path) => {
      if (smokeTrashFailurePath && hostPathEquals(path, smokeTrashFailurePath)) {
        throw new Error('Injected recoverable Trash failure')
      }
      const recovered = joinHostPath(
        smokeTrashRecoveryRoot,
        `${(smokeTrashSequence += 1)}-${basenameHostPath(path)}`,
      )
      await host.fileTransfer.renameNoReplace(path, recovered)
      smokeRecoveredPaths.add(recovered)
    },
  })
  const externalMoveSmoke = createExternalMoveSmokeControl()
  const supervisor = new PtySupervisor()
  let smokeWindow: BrowserWindow | undefined
  let cleanupFailureResource: ReturnType<typeof smokeCleanupResource> = null
  let discardedRendererGenerations = 0
  let stopSmokeWatch: Disposer | undefined
  const smokeCloseableRoot = joinHostPath(smokeRoot, '.hvir-smoke-closed-project')
  const smokeWebSwitchRoot = joinHostPath(smokeRoot, 'docs')
  const oversizedDiffPath = joinHostPath(smokeRoot, '.hvir-smoke-oversized-diff.txt')
  const createdPointerPath = joinHostPath(smokeRoot, '.hvir-smoke-created-pointer.txt')
  const renamedPointerPath = joinHostPath(smokeRoot, '.hvir-smoke-renamed-pointer.txt')
  const createdKeyboardPath = joinHostPath(smokeRoot, '.hvir-smoke-created-keyboard')
  const organizationTargetPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-organization-target',
  )
  const createdSnapshotPath = joinHostPath(smokeRoot, '.hvir-smoke-created-snapshot.txt')
  const documentReviewFixturePath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review.md',
  )
  const documentReviewCaptureAPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review-a.bin',
  )
  const documentReviewCaptureBPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review-b.bin',
  )
  const documentReviewFixtureContents =
    '# Review fixture\n\nFirst paragraph for a rendered comment.\n\n' +
    'Second paragraph for keyboard navigation.\n\n' +
    'Third paragraph keeps the exact context unique.\n'
  const cleanup = new SmokeCleanup((name) => interruptionCheckpoint.disposed(name), {
    onFailure: (name) => {
      cleanupFailureResource = smokeCleanupResource(name)
      reportSmokeFailureEvidence(
        'cleanup',
        smokeOwnedResourceEvidence(
          smokeWindow,
          supervisor,
          stopSmokeWatch !== undefined,
          rendererResources,
        ),
        null,
        cleanupFailureResource,
      )
    },
  })
  cleanup.defer('echo worker', () => worker.dispose())
  cleanup.defer('Git worker', () => git.dispose())
  cleanup.defer('filename search', () => filenameSearch.dispose())
  cleanup.defer('local host', () => host.dispose())
  cleanup.defer('recoverable deletion fixture', async () => {
    for (const recovered of smokeRecoveredPaths) {
      await host.exec('rm', ['-rf', '--', recovered.path])
    }
    await host.fileTransfer.removeDirectory(smokeTrashRecoveryRoot, {
      ignoreMissing: true,
    })
  })
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
  cleanup.defer('oversized diff fixture', () =>
    host.exec('rm', ['-f', '--', oversizedDiffPath.path]).then(() => undefined),
  )
  cleanup.defer('created pointer fixture', () =>
    host
      .exec('rm', ['-f', '--', createdPointerPath.path, renamedPointerPath.path])
      .then(() => undefined),
  )
  cleanup.defer('created keyboard fixture', () =>
    host
      .exec('rm', ['-rf', '--', createdKeyboardPath.path, organizationTargetPath.path])
      .then(() => undefined),
  )
  cleanup.defer('created snapshot fixture', () =>
    host.exec('rm', ['-f', '--', createdSnapshotPath.path]).then(() => undefined),
  )
  cleanup.defer('document review workflow fixtures', () =>
    host
      .exec('rm', [
        '-f',
        '--',
        documentReviewFixturePath.path,
        documentReviewCaptureAPath.path,
        documentReviewCaptureBPath.path,
      ])
      .then(() => undefined),
  )
  cleanup.defer('project watch', async () => {
    await stopSmokeWatch?.()
    stopSmokeWatch = undefined
  })
  cleanup.defer('supervised terminals', () => supervisor.disposeAllAndWait())
  cleanup.defer('smoke window', async () => {
    if (!smokeWindow || smokeWindow.isDestroyed()) return
    const ownerId = smokeWindow.webContents.id
    await webPaneRoutes.closeOwner(ownerId)
    smokeWindow.destroy()
  })
  let smokeProjectRevision = 0
  const commitSmokeProjectState = (state: ProjectState): ProjectState => ({
    ...state,
    revision: (smokeProjectRevision += 1),
  })
  const smokeProjectState = (
    connectionState = host.connectionState,
    missing = false,
  ): ProjectState => ({
    revision: smokeProjectRevision,
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
  const smokeRemoteHost = createRemoteProjectFileSmokeHost({
    localHost: host,
    localRoot: smokeRoot,
    remoteRoot: smokeRemoteRoot,
  })
  const smokeRemoteProjectState = (): ProjectState => ({
    revision: smokeProjectRevision,
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
  const smokeSessionsProjectionState = (): ProjectState => ({
    revision: smokeProjectRevision,
    root: smokeRoot,
    connectionState: 'connected',
    watchTier: host.watchTier,
    activeProjectId: `project:${smokeRoot.hostId}:${smokeRoot.path}`,
    activeWorkspaceId: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
    projects: [
      {
        id: `project:${smokeRoot.hostId}:${smokeRoot.path}`,
        registeredRoot: smokeRoot,
        displayName: 'Primary project',
        connectionState: 'connected',
        watchTier: host.watchTier,
        activeWorkspaceId: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
        workspaces: [
          {
            ...smokeProjectState().projects[0]!.workspaces[0]!,
            id: `workspace:${smokeRoot.hostId}:${smokeRoot.path}`,
          },
          {
            id: `workspace:${smokeWebSwitchRoot.hostId}:${smokeWebSwitchRoot.path}`,
            root: smokeWebSwitchRoot,
            name: 'feature/sessions',
            main: false,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
      {
        id: `project:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
        registeredRoot: smokeCloseableRoot,
        displayName: 'Secondary project',
        connectionState: 'connected',
        watchTier: host.watchTier,
        activeWorkspaceId: `workspace:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
        workspaces: [
          {
            id: `workspace:${smokeCloseableRoot.hostId}:${smokeCloseableRoot.path}`,
            root: smokeCloseableRoot,
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
      {
        id: `project:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
        registeredRoot: smokeRemoteRoot,
        displayName: 'Disconnected project',
        connectionState: 'disconnected',
        watchTier: 'polling',
        activeWorkspaceId: `workspace:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
        workspaces: [
          {
            id: `workspace:${smokeRemoteRoot.hostId}:${smokeRemoteRoot.path}`,
            root: smokeRemoteRoot,
            name: 'remote-main',
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
  const smokeRemoteFileProjectState = (): ProjectState => ({
    revision: smokeProjectRevision,
    root: smokeRemoteRoot,
    connectionState: 'connected',
    watchTier: 'polling',
    activeProjectId: 'smoke-remote-file-project',
    activeWorkspaceId: 'smoke-remote-file-workspace',
    projects: [
      {
        id: 'smoke-remote-file-project',
        registeredRoot: smokeRemoteRoot,
        displayName: 'remote-hvir',
        connectionState: 'connected',
        watchTier: 'polling',
        activeWorkspaceId: 'smoke-remote-file-workspace',
        workspaces: [
          {
            id: 'smoke-remote-file-workspace',
            root: smokeRemoteRoot,
            name: 'feature/files',
            main: true,
            closed: false,
            missing: false,
            repository: false,
            changedFiles: 0,
          },
        ],
      },
    ],
  })
  const smokeProjectReturnState = (activeProjectId: string): ProjectState => {
    const primary = smokeProjectState().projects[0]!
    const secondaryWorkspaceId = 'smoke-project-return-workspace'
    const secondary = {
      id: 'smoke-project-return',
      registeredRoot: smokeWebSwitchRoot,
      displayName: 'return-fixture',
      connectionState: host.connectionState,
      watchTier: host.watchTier,
      activeWorkspaceId: secondaryWorkspaceId,
      workspaces: [
        {
          id: secondaryWorkspaceId,
          root: smokeWebSwitchRoot,
          name: 'return-fixture',
          main: true,
          closed: false,
          missing: false,
          repository: true,
          changedFiles: 0,
        },
      ],
    }
    const activeSecondary = activeProjectId === secondary.id
    return {
      revision: smokeProjectRevision,
      root: activeSecondary ? smokeWebSwitchRoot : smokeRoot,
      connectionState: host.connectionState,
      watchTier: host.watchTier,
      activeProjectId: activeSecondary ? secondary.id : primary.id,
      activeWorkspaceId: activeSecondary
        ? secondaryWorkspaceId
        : primary.activeWorkspaceId,
      projects: [primary, secondary],
    }
  }
  const liveReloadPath = joinHostPath(smokeRoot, '.hvir-smoke-live.txt')
  const viewerPositionPath = joinHostPath(smokeRoot, '.hvir-smoke-position.md')
  const largeJsonPath = joinHostPath(smokeRoot, '.hvir-smoke-large.json')
  const largeTextPath = joinHostPath(smokeRoot, '.hvir-smoke-large.txt')
  const harnessProfilesPath = joinHostPath(smokeRoot, '.hvir-smoke-harness-profiles.json')
  const documentReviewPath = joinHostPath(
    smokeRoot,
    '.hvir-smoke-document-review-drafts.json',
  )
  let scenarioFailed = false
  let failurePhase: SmokeFailurePhase = 'resources-created'
  let failureCheckpoint: SmokeFailureCheckpoint | null = null
  const recordSmokePhase = (phase: SmokeFailurePhase): void => {
    failurePhase = phase
    failureCheckpoint = null
    reportSmokeFailureEvidence(
      phase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        supervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
    )
  }
  const recordSmokeCheckpoint = (checkpoint: SmokeFailureCheckpoint): void => {
    failureCheckpoint = checkpoint
    reportSmokeFailureEvidence(
      failurePhase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        supervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
      checkpoint,
    )
  }
  recordSmokePhase(failurePhase)
  try {
    if (mode === 'workflow') {
      const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
      if (echo.text !== 'ping') throw new Error(`echo mismatch: ${echo.text}`)
      if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
      console.log(`[smoke] echo worker OK (pid ${echo.workerPid})`)
    }
    // Exercise the real renderer → main → worker path.
    await host.connect()
    recordSmokePhase('host-connected')
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
    if (mode === 'terminal-presentation') {
      await host.writeFile(
        oversizedDiffPath,
        `${'oversized diff fixture '.padEnd(255, 'x')}\n`.repeat(8_200),
      )
    }
    if (mode === 'document-review') {
      await host.writeFile(documentReviewFixturePath, documentReviewFixtureContents)
    }
    if (mode === 'workspace-remote') {
      await host.exec('rm', [
        '-f',
        '--',
        createdPointerPath.path,
        renamedPointerPath.path,
        createdSnapshotPath.path,
      ])
      await host.createDirectoryExclusive(smokeTrashRecoveryRoot, { mode: 0o755 })
      await host.exec('rm', [
        '-rf',
        '--',
        createdKeyboardPath.path,
        organizationTargetPath.path,
      ])
    }
    const emit: EmitSmokeEvent = (channel, payload) => {
      if (smokeWindow && !smokeWindow.isDestroyed())
        sendRendererEvent(smokeWindow.webContents, channel, payload)
    }
    const smokeTerminalSessionHarness = createSmokeTerminalSessionStore(smokeRoot)
    const smokeTerminalSessions = smokeTerminalSessionHarness.store
    const smokeSessionsProviders = new HarnessProviderRegistry([
      ...harnessProviders.all(),
      sessionsUsageSmokeProvider,
    ])
    const smokeHarnessProfiles = await HarnessProfileStore.load(host, harnessProfilesPath)
    await host.removeFile(documentReviewPath, { ignoreMissing: true })
    cleanup.defer('document review draft', () =>
      host.removeFile(documentReviewPath, { ignoreMissing: true }),
    )
    const documentReview = await createDocumentReviewRuntime(
      host,
      documentReviewPath,
      rendererResources,
      {
        ptys: supervisor,
        sessions: smokeTerminalSessions,
        providers: harnessProviders,
        profiles: smokeHarnessProfiles,
      },
    )
    cleanup.defer('document review', () => documentReview.dispose())
    let smokeIpcProjectState = commitSmokeProjectState(
      mode === 'terminal-presentation' || mode === 'document-review'
        ? smokeProjectReturnState('smoke-project')
        : smokeProjectState(),
    )
    const smokeProjectObservationListeners = new Set<() => void>()
    const setSmokeProjectState = (state: ProjectState): ProjectState => {
      const committed = commitSmokeProjectState(state)
      smokeIpcProjectState = committed
      for (const listener of smokeProjectObservationListeners) listener()
      return committed
    }
    const smokeHostOptions = () => [
      {
        hostId: host.hostId,
        label: 'Local',
        kind: 'local' as const,
        connectionState: host.connectionState,
        watchTier: host.watchTier,
      },
      {
        hostId: smokeRemoteHost.hostId,
        label: 'Smoke SSH',
        kind: 'ssh' as const,
        connectionState: smokeRemoteHost.connectionState,
        watchTier: smokeRemoteHost.watchTier,
      },
    ]
    const sessionsObservation = new SessionsObservationPort({
      projectState: () => smokeIpcProjectState,
      hosts: smokeHostOptions,
      providers: () =>
        smokeSessionsProviders.all().map((provider) => ({
          id: provider.manifest.id,
          displayName: provider.manifest.displayName,
          telemetrySupported: Boolean(provider.telemetry),
          usageSupported: Boolean(provider.usageTelemetry),
          sessionKind: provider.manifest.sessionKind,
        })),
      sessions: smokeTerminalSessions,
      ptys: supervisor,
      observeProjects: (listener) => {
        smokeProjectObservationListeners.add(listener)
        return () => {
          smokeProjectObservationListeners.delete(listener)
        }
      },
      emit: (owner, change) => {
        if (
          smokeWindow?.webContents.id === owner.id &&
          rendererResources.isCurrent(owner)
        ) {
          sendRendererEvent(smokeWindow.webContents, 'sessions:changed', change)
        }
      },
    })
    cleanup.defer('Sessions observation', () => sessionsObservation.dispose())
    const sessionsUsageDemand = new HarnessUsageDemandController(smokeSessionsProviders)
    cleanup.defer('Sessions usage demand', () => sessionsUsageDemand.dispose())
    const sessionsUsage = new SessionsUsageObservationPort({
      sessions: sessionsObservation,
      ptys: supervisor,
      usage: sessionsUsageDemand,
      emit: (owner, change) => {
        if (
          smokeWindow?.webContents.id === owner.id &&
          rendererResources.isCurrent(owner)
        ) {
          sendRendererEvent(smokeWindow.webContents, 'sessions:usage-changed', change)
        }
      },
    })
    cleanup.defer('Sessions usage observation', () => sessionsUsage.dispose())
    const openedFolderSelections: Array<{ hostId: string; path: string }> = []
    const revealedEntries: HostPath[] = []
    const terminalMoveSmoke = createTerminalMoveSmokeHarness({
      sourceState: smokeProjectState,
      targetRoot: smokeWebSwitchRoot,
      supervisor,
      resources: rendererResources,
      webPanes: webPaneRoutes,
      onState: setSmokeProjectState,
    })
    const workspaceCloseCommands = workspaceCloseSmokeCommands({
      host,
      getState: () => smokeIpcProjectState,
      setState: setSmokeProjectState,
      cleanup: createWorkspaceCleanup({
        ptys: supervisor,
        resources: rendererResources,
        sessions: smokeTerminalSessions,
        webPanes: webPaneRoutes,
        releaseHtmlPreviews: (root) => htmlPreviews.releaseWorkspace(root),
      }),
    })
    const projectFiles = createProjectFileOperationCoordinator(
      {
        state: () => smokeIpcProjectState,
        hostById: (hostId) =>
          hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host,
      },
      rendererResources,
      externalMoveSmoke.picker,
    )
    cleanup.defer('project file operations', () => projectFiles.dispose())
    const browseSmokeHost = async (_hostId: string, path: string) => {
      if (path.endsWith('.missing')) throw new Error(`Folder not found: ${path}`)
      const canonical = await host.realpath(localPath(path))
      const directories = (await host.readdir(canonical)).filter(
        (entry) => entry.type === 'dir',
      )
      return { path: canonical, directories }
    }
    const projectFolderPicker = new ProjectFolderPickerCoordinator(
      {
        hostById: (hostId) =>
          hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host,
        browseHost: browseSmokeHost,
      },
      rendererResources,
    )
    let acceptedRendererReadySink: ((owner: RendererOwner) => void) | undefined
    const ipcRouter = registerIpcHandlers({
      echoWorker: worker,
      gitWorker: git,
      filenameSearch,
      projectFiles,
      projectFolderPicker,
      documentReview: documentReview.coordinator,
      documentReviewDelivery: documentReview.delivery,
      getProject: () =>
        smokeIpcProjectState.root.hostId === smokeRemoteHost.hostId
          ? { host: smokeRemoteHost, root: smokeRemoteRoot }
          : { host, root: smokeRoot },
      getHost: (hostId) => (hostId === smokeRemoteHost.hostId ? smokeRemoteHost : host),
      connectedHosts: () => [host],
      getRegisteredWorkspaceRoot: (root) =>
        hostPathEquals(root, smokeRoot) ||
        hostPathEquals(root, smokeCloseableRoot) ||
        hostPathEquals(root, smokeWebSwitchRoot) ||
        hostPathEquals(root, smokeRemoteRoot)
          ? root
          : undefined,
      revealLocalEntry: (path) => revealedEntries.push(path),
      getProjectState: () => smokeIpcProjectState,
      listHosts: smokeHostOptions,
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
      browseHost: browseSmokeHost,
      openProject: (hostId, path) => {
        openedFolderSelections.push({ hostId, path })
        return Promise.resolve(setSmokeProjectState(smokeProjectState()))
      },
      switchWorkspace: (projectId) => {
        const state = setSmokeProjectState(
          mode === 'sessions-projection'
            ? smokeIpcProjectState
            : mode === 'terminal-presentation' || mode === 'document-review'
              ? smokeProjectReturnState(projectId)
              : smokeProjectState(),
        )
        if (mode === 'terminal-presentation' || mode === 'document-review') {
          emit('project:state', state)
        }
        return Promise.resolve(state)
      },
      refreshProject: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
      updateWatchInterests: (paths) =>
        Promise.resolve({
          accepted: Math.min(paths.length, MAX_PROJECT_WATCH_INTERESTS),
          limited: paths.length > MAX_PROJECT_WATCH_INTERESTS,
        }),
      closeProject: () => {
        return Promise.resolve(setSmokeProjectState(smokeProjectState()))
      },
      pruneWorktrees: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
      dismissWorkspace: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
      planWorkspaceClose: workspaceCloseCommands.planWorkspaceClose,
      closeWorkspace: workspaceCloseCommands.closeWorkspace,
      reopenWorkspace: workspaceCloseCommands.reopenWorkspace,
      acknowledgeWorkspace: () =>
        Promise.resolve(setSmokeProjectState(smokeProjectState())),
      switchGitBranch: async (_root, branch) => {
        const result = await host.exec('git', [
          '-C',
          smokeRoot.path,
          'switch',
          '--no-guess',
          branch,
        ])
        if (result.code !== 0) throw new Error(result.stderr)
        return setSmokeProjectState(smokeProjectState())
      },
      fetchGit: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
      pullGit: () => Promise.resolve(setSmokeProjectState(smokeProjectState())),
      respondSshPrompt: () => undefined,
      rendererResources,
      rendererReady: (owner, reportedGeneration) => {
        const accepted = dependencies.rendererReady(owner, reportedGeneration)
        if (accepted) acceptedRendererReadySink?.(owner)
        return accepted
      },
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
      sessionsObservation,
      sessionsUsage,
      terminalMoves: terminalMoveSmoke.coordinator,
      harnessProfiles: smokeHarnessProfiles,
      harnessProbes: harnessProbeManager,
      remoteImagePaste: createSmokeImagePasteFallback(supervisor),
      // A scenario must not overwrite the clipboard of the machine running it.
      systemClipboard: { writeText: () => undefined },
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
    recordSmokePhase('watch-active')
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
    await new Promise<void>((resolve) => win.once('ready-to-show', resolve))
    const initialRendererGeneration = rendererResources.currentOwner(
      win.webContents.id,
    ).generation
    recordSmokePhase('window-ready')
    console.log('[smoke] window ready-to-show OK')
    // A real preload round-trip establishes more than ready-to-show paint.
    const rendererResult = (await win.webContents.executeJavaScript(`
        Promise.all([
          window.hvir.invoke('app:info', undefined),
          window.hvir.invoke('demo:echo', { text: 'renderer-ping' })
        ]).then(([info, echoed]) => ({ info, echoed }))
      `)) as {
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
    recordSmokePhase('renderer-ready')
    const predecessorSelectionObserved = await recordRendererIsolationSelection(
      win,
      interruptionCheckpoint,
    )
    await interruptionCheckpoint.reach({
      name: 'renderer-watch-ready',
      ownerGeneration: initialRendererGeneration,
      watcherActive: stopSmokeWatch !== undefined,
      predecessorSelectionObserved,
    })
    recordSmokePhase('scenario-active')
    if (await verifyDevelopmentPerformanceMode(win, mode)) return 0
    if (mode === 'renderer-recovery') {
      const replacementReady = new Promise<RendererOwner>((resolve) => {
        acceptedRendererReadySink = (owner) => {
          if (
            owner.id === win.webContents.id &&
            owner.generation === initialRendererGeneration
          ) {
            return
          }
          resolve(owner)
        }
      })
      let result: string
      try {
        result = await verifyRendererProcessRecovery({
          win,
          resources: rendererResources,
          diagnostics: dependencies.runtimeDiagnostics,
          supervisor,
          routes: webPaneRoutes,
          root: smokeRoot,
          liveReloadPath,
          host,
          replacementReady,
          checkpoint: recordSmokeCheckpoint,
        })
      } finally {
        acceptedRendererReadySink = undefined
      }
      if (discardedRendererGenerations !== 1) {
        throw new Error(
          `renderer recovery discarded resources ${discardedRendererGenerations} times`,
        )
      }
      console.log(`[smoke] renderer recovery OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'sessions-projection') {
      const replacementReady = new Promise<RendererOwner>((resolve) => {
        acceptedRendererReadySink = (owner) => {
          if (
            owner.id === win.webContents.id &&
            owner.generation === initialRendererGeneration
          ) {
            return
          }
          resolve(owner)
        }
      })
      let result: string
      try {
        result = await verifySessionsProjectionSmoke({
          win,
          initialOwner: rendererResources.currentOwner(win.webContents.id),
          resources: rendererResources,
          replacementReady,
          state: smokeSessionsProjectionState(),
          publishState: (state) => emit('project:state', setSmokeProjectState(state)),
          providerId: defaultHarnessProviderId,
          roots: [smokeWebSwitchRoot, smokeCloseableRoot, smokeRemoteRoot],
          addRetained: smokeTerminalSessionHarness.add,
          supervisor,
          usageHost: host,
          usageProvider: sessionsUsageSmokeProvider,
        })
      } finally {
        acceptedRendererReadySink = undefined
      }
      console.log(`[smoke] Sessions projection OK (${result})`)
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
    if (mode === 'workspace-remote') {
      const projectFilesResult = await verifyProjectFileOperationsSmoke({
        win,
        localHost: host,
        localRoot: smokeRoot,
        remoteRoot: smokeRemoteRoot,
        switchedRoot: smokeWebSwitchRoot,
        trashRecoveryRoot: smokeTrashRecoveryRoot,
        externalMove: externalMoveSmoke,
        failTrashFor: (path) => {
          smokeTrashFailurePath = path
        },
        localState: smokeProjectState,
        remoteState: smokeRemoteFileProjectState,
        switchedState: () => smokeProjectReturnState('smoke-project-return'),
        publish: (state) => emit('project:state', setSmokeProjectState(state)),
        revealedEntries,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] project file operations OK (${projectFilesResult})`)
      const result = await verifyWorkspaceRemoteWorkflow({
        win,
        host,
        supervisor,
        resources: rendererResources,
        activeRoot: smokeRoot,
        closeRoot: smokeWebSwitchRoot,
        getState: () => smokeIpcProjectState,
        setState: setSmokeProjectState,
        emitState: (state) => emit('project:state', state),
        baseState: smokeProjectState,
        remoteState: smokeRemoteProjectState,
        emitHostKeyPrompt: () =>
          emit('ssh:prompt', {
            id: 9001,
            hostId: 'smoke-host',
            kind: 'host-key',
            title: 'Trust smoke-host?',
            instructions: 'Verify the SHA-256 fingerprint before trusting this host.',
            fingerprint: `SHA256:${'abcdefghijklmnopqrstuvwxyz'.repeat(4)}`,
            prompts: [],
          }),
        openedFolderSelections,
        recovery: {
          add: smokeTerminalSessionHarness.add,
          has: smokeTerminalSessionHarness.has,
        },
      })
      console.log(`[smoke] workspace + remote workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'web-pane') {
      const result = await verifyWebPaneWorkflow({
        win,
        supervisor,
        resources: rendererResources,
        routes: webPaneRoutes,
        activeRoot: smokeRoot,
        switchRoot: smokeWebSwitchRoot,
        baseState: smokeProjectState,
        setState: setSmokeProjectState,
        emitState: (state) => emit('project:state', state),
        interruptionCheckpoint,
        predecessorSelectionObserved,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] web pane workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'renderer-authority') {
      const result = await verifyRendererAuthorityLifecycle({
        win,
        resources: rendererResources,
        checkpoint: recordSmokeCheckpoint,
      })
      console.log(`[smoke] renderer authority lifecycle OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'document-review') {
      const documentReviewProvider = harnessProviders
        .all()
        .find((provider) => provider.documentReviewSendNow)
      if (!documentReviewProvider) {
        throw new Error('No harness provider supports document review send-now')
      }
      const result = await verifyDocumentReviewWorkflow({
        win,
        host,
        root: smokeRoot,
        document: documentReviewFixturePath,
        documentContents: documentReviewFixtureContents,
        captureA: documentReviewCaptureAPath,
        captureB: documentReviewCaptureBPath,
        reviewFile: documentReviewPath,
        review: documentReview,
        profiles: smokeHarnessProfiles,
        provider: documentReviewProvider,
        supervisor,
        resources: rendererResources,
      })
      console.log(`[smoke] document review workflow OK (${result})`)
      console.log('HVIR_SMOKE_OK')
      return 0
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
        recordSmokeCheckpoint,
        smokeRoot,
      )
      console.log(`[smoke] terminal presentation lifecycle OK (${presentation})`)
      console.log('HVIR_SMOKE_OK')
      return 0
    }
    if (mode === 'terminal-lifecycle') {
      const launchStatus = await ensureExplicitBareShellLaunch(win, supervisor)
      const reconnectStatus = await verifyTerminalReconnectRemount({
        win,
        supervisor,
        resources: rendererResources,
        root: smokeRoot,
        connectedState: smokeProjectState('connected'),
        disconnectedState: smokeProjectState('disconnected'),
        emitProjectState: (state) => {
          const committed = setSmokeProjectState(state)
          emit('project:state', committed)
        },
      })
      const recoveryStatus = await verifyRendererRolloverRecovery({
        win,
        supervisor,
        root: smokeRoot,
        providerId: defaultHarnessProviderId,
        setRecoverySessions: (sessions) => {
          smokeTerminalSessionHarness.set(sessions)
        },
      })
      await verifyTerminalRendererDestruction({
        win,
        initialGeneration: initialRendererGeneration,
        resources: rendererResources,
        supervisor,
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
    const profileSmoke = (await win.webContents.executeJavaScript(`
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
            profile,
            preview,
            obsoleteRiskState:
              'risk' in profile ||
              'riskAcknowledgedRevision' in profile ||
              'risk' in preview
          };
        })()
      `)) as {
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
        launchRevision: number
      }
      preview: { args: readonly string[]; command: string }
      obsoleteRiskState: boolean
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
      profileSmoke.obsoleteRiskState ||
      !profileSmoke.preview.args.includes(smokeRoot.path) ||
      !profileSmoke.preview.command.includes("HVIR_PROFILE_SMOKE='structured'")
    ) {
      throw new Error('structured Custom profile did not preserve preview semantics')
    }
    console.log('[smoke] structured profile catalog + preview OK')

    const terminalMoveStatus = await verifyTerminalMoveSmoke({
      win,
      supervisor,
      harness: terminalMoveSmoke,
      emitState: (state) => emit('project:state', state),
    })
    console.log(`[smoke] live terminal worktree move OK (${terminalMoveStatus})`)

    const themeStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const initial = document.documentElement.dataset.theme;
          const canvas = document.querySelector('.terminal-container canvas');
          const terminal = canvas?.closest('.terminal-container');
          const engine = terminal?.querySelector('.terminal-engine-host');
          const toggle = document.querySelector('.theme-toggle');
          const shell = document.querySelector('.app-shell');
          if (!canvas || !terminal || !engine || !toggle || !shell) return reject(new Error('theme smoke controls missing'));
          const terminalBackgroundMatches = () => {
            const expected = terminal.getAttribute('data-terminal-theme') === 'light'
              ? 'rgb(236, 236, 231)'
              : 'rgb(17, 19, 24)';
            return getComputedStyle(terminal).backgroundColor === expected;
          };
          const before = getComputedStyle(shell).backgroundColor;
          const terminalBefore = getComputedStyle(canvas).filter;
          const paletteBefore = engine.__hvirTerminalPerformance?.palette?.background;
          if (terminalBefore !== 'none' || !paletteBefore) {
            return reject(new Error('terminal Canvas still uses a color filter'));
          }
          if (!terminalBackgroundMatches()) {
            return reject(new Error('terminal host background does not match its palette'));
          }
          toggle.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const current = document.documentElement.dataset.theme;
            const after = getComputedStyle(shell).backgroundColor;
            const terminalAfter = getComputedStyle(canvas).filter;
            const paletteAfter = engine.__hvirTerminalPerformance?.palette?.background;
            if (current === initial || before === after) {
              return reject(new Error('chrome theme did not change'));
            }
            if (
              terminalAfter !== 'none' ||
              !paletteAfter ||
              paletteBefore === paletteAfter
            ) {
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
              if (
                document.documentElement.dataset.theme !== initial ||
                engine.__hvirTerminalPerformance?.palette?.background !== paletteBefore
              ) {
                return reject(new Error('theme did not restore'));
              }
              resolve(initial + '→' + current + '→' + initial + ' · PTY canvas retained');
            });
          }));
        })
      `)) as string
    console.log(`[smoke] synchronized theme switch OK (${themeStatus})`)

    const railNavigationStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const railButtons = [...document.querySelectorAll('.rail-nav button')];
          const byLabel = (label) =>
            railButtons.find((node) => node.textContent?.trim().startsWith(label));
          const files = byLabel('Files');
          const sessions = document.querySelector('.sessions-destination');
          const directory = [...document.querySelectorAll('[aria-label="Files"] .tree-directory')]
            .find((node) => node.querySelector(':scope > .directory-row')
              ?.getAttribute('title')?.endsWith('/src'));
          if (!files || !(sessions instanceof HTMLButtonElement) || !directory) {
            return reject(new Error('stable rail navigation controls missing'));
          }
          const directoryRow = directory.querySelector(':scope > .directory-row');
          if (directoryRow?.getAttribute('aria-expanded') !== 'true') directoryRow?.click();
          const tabsBefore = document.querySelectorAll('.viewer-tab').length;
          sessions.click();
          const waitForSessions = () => {
            const overview = document.querySelector('.sessions-overview');
            const workbench = document.querySelector('.workbench');
            if (
              sessions.disabled ||
              !sessions.classList.contains('active') ||
              sessions.getAttribute('aria-current') !== 'page' ||
              !overview ||
              !(workbench instanceof HTMLElement) ||
              !workbench.hidden
            ) {
              return setTimeout(waitForSessions, 25);
            }
            const returnToWorkspace = overview.querySelector('.sessions-return');
            if (!(returnToWorkspace instanceof HTMLButtonElement)) {
              return reject(new Error('Sessions return control missing'));
            }
            returnToWorkspace.click();
            const waitForFiles = () => {
              const currentFiles = [...document.querySelectorAll('.rail-nav button')]
                .find((node) => node.textContent?.trim().startsWith('Files'));
              const ready = directory.isConnected &&
                directoryRow?.getAttribute('aria-expanded') === 'true' &&
                document.querySelectorAll('.viewer-tab').length === tabsBefore &&
                currentFiles?.classList.contains('active') &&
                !sessions.disabled &&
                !document.querySelector('.sessions-overview');
              if (ready) {
                return resolve(
                  'stable tabs · Files state preserved · Sessions full-page round trip'
                );
              }

              setTimeout(waitForFiles, 25);
            };
            waitForFiles();
          };
          waitForSessions();
        })
      `)) as string
    console.log(`[smoke] rail navigation OK (${railNavigationStatus})`)

    const resizeStatus = (await win.webContents.executeJavaScript(`
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
      `)) as string
    console.log(`[smoke] pane dividers OK (${resizeStatus})`)

    const resizerActionStatus = (await win.webContents.executeJavaScript(`
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
      `)) as string
    console.log(`[smoke] pane action drags OK (${resizerActionStatus})`)

    const splitStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
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
                    setTimeout(waitForCollapse, 50);
                  };
                  waitForCollapse();
                });
              }
              setTimeout(waitForTerminal, 50);
            };
            waitForTerminal();
          };
          terminalSplit();
        })
      `)) as string
    console.log(`[smoke] split panes OK (${splitStatus})`)

    const settingsStatus = (await win.webContents.executeJavaScript(`
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
      `)) as string
    console.log(`[smoke] minimal settings OK (${settingsStatus})`)

    const manualProfileStatus = await verifyHarnessManualProfilePointerActivation(win)
    console.log(`[smoke] manual harness profile OK (${manualProfileStatus})`)

    const harnessRenameStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          document.querySelector(
            '.terminal-icon-button[aria-label="New terminal"]'
          )?.click();
          const waitForProfile = () => {
            const rows = [...document.querySelectorAll('.settings-profile-list button')];
            const source = rows.find((row) =>
              row.querySelector('strong')?.textContent?.trim() === 'Smoke custom harness'
            );
            if (!source) {
              return setTimeout(waitForProfile, 50);
            }
            if (rows.some((row) =>
              row.querySelector('strong')?.textContent?.trim() === 'Shell'
            )) return reject(new Error('Bare Shell remained in the management list'));
            const sourceDetail = source.querySelector('small')?.textContent || '';
            if (!sourceDetail.includes('This project')) {
              return reject(new Error('configured profile row omitted scope metadata'));
            }
            const dialog = document.querySelector('.settings-dialog');
            const heading = document.querySelector('#settings-harnesses-title');
            const active = dialog?.querySelector('[aria-current="page"]')?.textContent?.trim();
            const profileEditor = dialog?.querySelector('.settings-profile-editor');
            if (!dialog || !heading || active !== 'Harnesses')
              return reject(new Error('configure harnesses did not target its section'));
            if (!profileEditor || profileEditor.scrollHeight > profileEditor.clientHeight + 1)
              return reject(new Error('default harness profile requires scrolling'));
            const disclosures = [...profileEditor.querySelectorAll(
              '.settings-profile-disclosure'
            )];
            if (disclosures.length !== 2 || disclosures.some((details) => details.open)) {
              return reject(new Error('harness common/advanced/preview hierarchy is unclear'));
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
                      const previewDisclosure = document.querySelector(
                        '.settings-profile-preview-disclosure'
                      );
                      previewDisclosure.open = true;
                      const previews = [...document.querySelectorAll(
                        '.settings-profile-previews code'
                      )].map((node) => node.textContent || '');
                      if (/2 argv values/.test(help) &&
                          previews.some((value) => value.includes('--add-dir'))) {
                        if (previews.length !== 1 || !previewDisclosure.open) {
                          return reject(new Error('Custom preview disclosure was not fresh-only'));
                        }
                        const previewSummary = previewDisclosure.querySelector('summary');
                        previewSummary.focus();
                        const focusStyle = getComputedStyle(previewSummary);
                        if (parseFloat(focusStyle.outlineWidth) < 1) {
                          return reject(new Error('preview disclosure focus is not visible'));
                        }
                        const initialTheme = document.documentElement.dataset.theme;
                        const hierarchySurface = document.querySelector(
                          '.settings-harness-layout'
                        );
                        const initialSurface = getComputedStyle(hierarchySurface).backgroundColor;
                        document.querySelector('.theme-toggle')?.click();
                        return requestAnimationFrame(() => {
                          const alternateTheme = document.documentElement.dataset.theme;
                          const alternateSurface = getComputedStyle(
                            hierarchySurface
                          ).backgroundColor;
                          if (!alternateTheme || alternateTheme === initialTheme ||
                              alternateSurface === initialSurface) {
                            return reject(new Error('harness hierarchy did not repaint across themes'));
                          }
                          document.querySelector('.theme-toggle')?.click();
                          [...document.querySelectorAll('.settings-dialog .dialog-actions button')]
                            .find((button) => button.textContent?.trim() === 'Close settings')
                            ?.click();
                          requestAnimationFrame(() => {
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

                            setTimeout(waitForGuardedSave, 50);
                          };
                          waitForGuardedSave();
                          });
                        });
                      }

                      setTimeout(waitForArgumentPreview, 50);
                    };
                    waitForArgumentPreview();
                  });
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

            requestAnimationFrame(waitForConfigure);
          };
          waitForConfigure();
        })
      `)) as string
    console.log(`[smoke] harness profile editor OK (${harnessRenameStatus})`)

    const harnessSettingsCaptures = await captureHarnessSettingsVisuals(
      win,
      host,
      process.env.HVIR_HARNESS_SETTINGS_CAPTURE_DIR
        ? localPath(process.env.HVIR_HARNESS_SETTINGS_CAPTURE_DIR)
        : undefined,
    )
    if (harnessSettingsCaptures.length > 0) {
      console.log(
        `[smoke] harness settings captures OK (${harnessSettingsCaptures.length})`,
      )
    }

    const compactHarnessStatus = await verifyCompactHarnessSettings(win)
    console.log(`[smoke] compact harness settings OK (${compactHarnessStatus})`)

    console.log('HVIR_SMOKE_OK')
    return 0
  } catch (err) {
    scenarioFailed = true
    reportSmokeFailureEvidence(
      failurePhase,
      smokeOwnedResourceEvidence(
        smokeWindow,
        supervisor,
        stopSmokeWatch !== undefined,
        rendererResources,
      ),
      failureCheckpoint,
    )
    console.error('HVIR_SMOKE_FAIL', err)
    return 1
  } finally {
    try {
      await cleanup.run()
    } catch (cleanupError) {
      reportSmokeFailureEvidence(
        'cleanup',
        smokeOwnedResourceEvidence(
          smokeWindow,
          supervisor,
          stopSmokeWatch !== undefined,
          rendererResources,
        ),
        null,
        cleanupFailureResource,
      )
      console.error('HVIR_SMOKE_CLEANUP_FAIL', cleanupError)
      // A successful scenario must still fail when cleanup does not complete.
      if (!scenarioFailed) {
        // eslint-disable-next-line no-unsafe-finally
        throw cleanupError
      }
    }
  }
}

function smokeOwnedResourceEvidence(
  win: BrowserWindow | undefined,
  supervisor: PtySupervisor,
  watcherActive: boolean,
  rendererResources: RendererResourceScopes,
): SmokeOwnedResourceEvidence {
  let rendererGeneration: number | null = null
  if (win && !win.isDestroyed()) {
    try {
      rendererGeneration = rendererResources.currentOwner(win.webContents.id).generation
    } catch {
      // A revoked owner is represented by the closed null/false fields below.
    }
  }
  return {
    windowCount: win && !win.isDestroyed() ? 1 : 0,
    ptyCount: supervisor.list().length,
    watcherActive,
    rendererOwnerActive: rendererGeneration !== null,
    rendererGeneration,
  }
}

async function recordRendererIsolationSelection(
  win: BrowserWindow,
  checkpoint: SmokeInterruptionCheckpoint,
): Promise<boolean> {
  const runToken = checkpoint.runToken
  if (!runToken) return false
  return (await win.webContents.executeJavaScript(`
    (() => {
      const key = 'hvir-smoke-isolation-run';
      const predecessor = localStorage.getItem(key);
      localStorage.setItem(key, ${JSON.stringify(runToken)});
      return predecessor === ${JSON.stringify(checkpoint.predecessorToken ?? '')};
    })()
  `)) as boolean
}

type EmitSmokeEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void
