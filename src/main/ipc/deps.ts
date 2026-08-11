import type {
  BrowseHostResponse,
  ConnectedHost,
  EchoWorkerProtocol,
  GitWorkerProtocol,
  HostPath,
  IpcEventChannel,
  IpcEventPayload,
  KeybindingMap,
  ProjectHostOption,
  ProjectState,
  ProjectWatchInterestsResponse,
  WorkspaceClosePlan,
  RenderContainmentDiagnosticBatch,
  WorkbenchHealthSnapshot,
} from '../../shared'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'
import type { HarnessProbeManager } from '../harness/harness-probe'
import type { RemoteImagePasteCoordinator } from '../harness/remote-image-paste'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { TerminalSessionStore } from '../terminal/session-registry'
import type { TerminalWorkspaceMoveCoordinator } from '../terminal/terminal-workspace-move-coordinator'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { WorkerClient } from '../worker-host'
import type { IpcContractDiagnostic } from './authority-router'
import type { DiagnosticReportCoordinator } from '../diagnostics/diagnostic-report-coordinator'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { FilenameSearchCoordinator } from '../filename-search/filename-search-coordinator'
import type { ProjectFileOperationCoordinator } from '../project-file-operations'
import type {
  DocumentReviewCoordinator,
  DocumentReviewDeliveryCoordinator,
} from '../document-review'

export type EmitRendererEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void

/** The application host's clipboard, narrowed to the one write hvir performs. */
export interface SystemClipboardPort {
  writeText(text: string): void
}

export interface IpcDeps {
  readonly echoWorker: WorkerClient<EchoWorkerProtocol>
  readonly gitWorker: WorkerClient<GitWorkerProtocol>
  readonly filenameSearch: Pick<FilenameSearchCoordinator, 'search' | 'cancel' | 'revoke'>
  readonly projectFiles: Pick<
    ProjectFileOperationCoordinator,
    | 'create'
    | 'acquireClipboard'
    | 'acquireDropped'
    | 'copyExternal'
    | 'discloseExternalMove'
    | 'acquireExternalMove'
    | 'releaseExternalMove'
    | 'moveExternal'
    | 'organize'
    | 'discloseDeletion'
    | 'delete'
    | 'cancel'
  >
  readonly documentReview: Pick<
    DocumentReviewCoordinator,
    'activate' | 'save' | 'revalidate'
  >
  readonly documentReviewDelivery: Pick<
    DocumentReviewDeliveryCoordinator,
    'preview' | 'destinations' | 'prepare' | 'insert' | 'sendNow'
  >
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  readonly getHost: (hostId: string) => ProjectHost | undefined
  readonly connectedHosts: () => readonly ProjectHost[]
  readonly getRegisteredWorkspaceRoot: (root: HostPath) => HostPath | undefined
  readonly getProjectState: () => ProjectState
  readonly listHosts: () => readonly ProjectHostOption[]
  readonly connectHost: (hostId: string, owner: RendererOwner) => Promise<ConnectedHost>
  readonly disconnectHost: (hostId: string) => Promise<ProjectHostOption>
  readonly browseHost: (
    hostId: string,
    path: string,
    owner: RendererOwner,
  ) => Promise<BrowseHostResponse>
  readonly openProject: (
    hostId: string,
    path: string,
    owner: RendererOwner,
  ) => Promise<ProjectState>
  readonly switchWorkspace: (
    projectId: string,
    workspaceId: string,
  ) => Promise<ProjectState>
  readonly refreshProject: (projectId: string) => Promise<ProjectState>
  readonly updateWatchInterests: (
    paths: readonly HostPath[],
  ) => Promise<ProjectWatchInterestsResponse>
  readonly closeProject: (projectId: string) => Promise<ProjectState>
  readonly pruneWorktrees: (projectId: string) => Promise<ProjectState>
  readonly dismissWorkspace: (
    projectId: string,
    workspaceId: string,
  ) => Promise<ProjectState>
  readonly planWorkspaceClose: (
    projectId: string,
    workspaceId: string,
  ) => Promise<WorkspaceClosePlan>
  readonly closeWorkspace: (
    projectId: string,
    workspaceId: string,
    expectedTerminalCount: number,
    terminateTerminals: boolean,
  ) => Promise<ProjectState>
  readonly reopenWorkspace: (
    projectId: string,
    workspaceId: string,
  ) => Promise<ProjectState>
  readonly acknowledgeWorkspace: (
    projectId: string,
    workspaceId: string,
  ) => Promise<ProjectState>
  readonly switchGitBranch: (root: HostPath, branch: string) => Promise<ProjectState>
  readonly fetchGit: (root: HostPath) => Promise<ProjectState>
  readonly pullGit: (root: HostPath) => Promise<ProjectState>
  readonly respondSshPrompt: (
    owner: RendererOwner,
    id: number,
    answers?: readonly string[],
  ) => void
  readonly rendererResources: RendererResourceScopes
  readonly rendererReady: (owner: RendererOwner, reportedGeneration: number) => void
  readonly getWorkbenchHealth: () => WorkbenchHealthSnapshot
  readonly acknowledgeWorkbenchHealth: (occurrenceId: string) => WorkbenchHealthSnapshot
  readonly diagnostics: {
    readonly reports: Pick<
      DiagnosticReportCoordinator,
      'create' | 'capture' | 'copy' | 'save' | 'cancel' | 'delete'
    >
    readonly evidence: Pick<RuntimeDiagnostics, 'evidenceState' | 'deleteEvidence'>
  }
  readonly recordIpcContractDiagnostic: (event: IpcContractDiagnostic) => void
  readonly recordRenderContainment: (
    owner: RendererOwner,
    batch: RenderContainmentDiagnosticBatch,
  ) => void
  readonly ptySupervisor: PtySupervisor
  readonly terminalSessions: TerminalSessionStore
  readonly terminalMoves: Pick<TerminalWorkspaceMoveCoordinator, 'plan' | 'move'>
  readonly harnessProfiles: HarnessProfileStoreContract
  readonly harnessProbes: HarnessProbeManager
  readonly remoteImagePaste: Pick<RemoteImagePasteCoordinator, 'pasteOrForward'>
  /** Defaults to the Electron clipboard; scenarios override it to stay inert. */
  readonly systemClipboard?: SystemClipboardPort
  readonly updateAttention: (owner: RendererOwner, count: number) => void
  readonly updateWebPaneBindings: (owner: RendererOwner, bindings: KeybindingMap) => void
  readonly updateWebPaneFullPage: (owner: RendererOwner, paneId?: string) => void
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly webPanes: WebPaneRouteRegistry
  readonly openExternal: (url: string) => Promise<void>
  readonly emit: EmitRendererEvent
}
