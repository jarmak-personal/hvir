/**
 * The typed IPC contract (renderer <-> main).
 *
 * This is the *single* source of truth for channel names and their
 * request/response shapes. Nothing outside this module and the preload bridge
 * may name a raw channel string; the renderer calls `window.hvir.invoke(...)`,
 * which is typed entirely against the maps below. Adding an IPC surface means
 * adding an entry here first.
 */

import type { Disposer } from './disposer'
import type { ComposerSubmitMode } from './composer-submit'
import type { DirEntry, FileType, WatchEvent } from './fs-types'
import type { HostPath } from './host-path'
import type {
  CreateHtmlPreviewRequest,
  CreateHtmlPreviewResponse,
  ReleaseHtmlPreviewRequest,
} from './html-preview'
import type {
  GitDiffRequest,
  GitDiffResponse,
  WriteFileRequest,
  WriteFileResponse,
} from './viewer-types'
import type {
  GitBlameRun,
  GitBlameRequest,
  GitChanges,
  GitChangesRequest,
  GitCommitDetail,
  GitCommitDetailRequest,
  GitHistoryPage,
  GitHistoryRequest,
  GitIgnoredEntriesRequest,
  GitIgnoredEntriesResponse,
  GitBranchModel,
  GitFetchRequest,
  GitPullRequest,
  GitSwitchBranchRequest,
} from './git-types'
import type { HostConnectionState, HostWatchTier } from './fs-types'
import type { HarnessTelemetry } from './harness-telemetry'
import type { HarnessProviderDescriptor, HarnessProviderId } from './harness-provider'
import type { HarnessProfileProbe } from './harness-provider'
import type {
  HarnessCommandPreview,
  HarnessPathGrant,
  HarnessProfile,
  HarnessProfileId,
  HarnessProfileInput,
} from './harness-profile'
import type { RegisteredProjectState } from './workspace-types'
import type { KeybindingAction, KeybindingMap } from './keybindings'
import type { WebPaneDiagnosticEvent } from './web-pane'
import type {
  RenderContainmentDiagnosticBatch,
  RendererDiagnosticSession,
} from './diagnostics'
import type { WorkbenchHealthSnapshot } from './workbench-health'
import type {
  DiagnosticEvidenceDeleteResult,
  DiagnosticEvidenceState,
} from './diagnostic-evidence'
import type {
  CaptureDiagnosticReportRequest,
  CreateDiagnosticReportRequest,
  DiagnosticReportActionResult,
  DiagnosticReportIdRequest,
  DiagnosticReportStateResult,
} from './diagnostic-report'
import type {
  DeleteResponsivenessDiagnosticsRequest,
  ResponsivenessDiagnosticsState,
  ResponsivenessObservation,
  ResponsivenessObservationBatch,
  StopResponsivenessDiagnosticsRequest,
} from './renderer-responsiveness'

export type WebPaneCommandAction =
  KeybindingAction | 'closeWebPane' | 'escapeWebPaneFocus'

/** Basic app/runtime info — the trivial round-trip that proves the contract. */
export interface AppInfo {
  readonly appVersion: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  readonly platform: string
}

export interface EchoRequest {
  readonly text: string
}

export interface EchoResponse {
  readonly text: string
  readonly workerPid: number
}

export interface ProjectRootResponse {
  readonly root: HostPath
}

export const MAX_PROJECT_WATCH_INTERESTS = 128

export interface ProjectWatchInterestsRequest {
  readonly root: HostPath
  readonly paths: readonly HostPath[]
}

export interface ProjectWatchInterestsResponse {
  readonly accepted: number
  readonly limited: boolean
}

export interface ProjectHostOption {
  readonly hostId: string
  readonly label: string
  readonly kind: 'local' | 'ssh'
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
}

export interface ProjectState extends ProjectRootResponse {
  readonly connectionState: HostConnectionState
  readonly watchTier: HostWatchTier
  readonly projects: readonly RegisteredProjectState[]
  readonly activeProjectId: string
  readonly activeWorkspaceId: string
}

export interface OpenProjectRequest {
  readonly hostId: string
  readonly path: string
}

export interface SwitchWorkspaceRequest {
  readonly projectId: string
  readonly workspaceId: string
}

export interface RefreshProjectRequest {
  readonly projectId: string
}

export type CloseProjectRequest = RefreshProjectRequest
export type PruneProjectWorktreesRequest = RefreshProjectRequest
export type DismissWorkspaceRequest = SwitchWorkspaceRequest
export type AcknowledgeWorkspaceRequest = SwitchWorkspaceRequest

export interface ConnectHostRequest {
  readonly hostId: string
}

export interface DisconnectHostRequest {
  readonly hostId: string
}

export interface ConnectedHost {
  readonly host: ProjectHostOption
  readonly suggestedPath: string
}

export interface BrowseHostRequest {
  readonly hostId: string
  readonly path: string
}

export interface BrowseHostResponse {
  readonly path: HostPath
  readonly directories: readonly DirEntry[]
}

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export function unwrapOperation<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export interface SshPromptRequest {
  readonly id: number
  readonly hostId: string
  readonly kind:
    'password' | 'passphrase' | 'keyboard-interactive' | 'host-key' | 'host-key-changed'
  readonly title: string
  readonly instructions?: string
  readonly fingerprint?: string
  readonly previousFingerprint?: string
  readonly prompts: readonly { readonly text: string; readonly echo: boolean }[]
}

export interface SshPromptResponse {
  readonly id: number
  readonly answers?: readonly string[]
}

export interface ReadDirectoryRequest {
  readonly path: HostPath
}

export interface ReadFileRequest {
  readonly path: HostPath
}

export interface ResolveEntryResponse {
  /** The renderer-facing link path, not the canonical target path. */
  readonly path: HostPath
  /** Target kind after canonical confinement and symlink resolution. */
  readonly type: FileType
}

export interface ReadFileResponse {
  readonly path: HostPath
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
  readonly binary: boolean
}

export interface ReadAssetResponse {
  readonly path: HostPath
  readonly data: Uint8Array
  readonly size: number
  readonly mimeType: string
}

export interface StartPtyRequest {
  readonly sessionId: string
  /**
   * Retained recovery record retired only after this fresh session starts and
   * its replacement record is durably committed.
   */
  readonly replacesSessionId?: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly cwd: HostPath
  readonly cols: number
  readonly rows: number
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly composerSubmitMode: ComposerSubmitMode
  /** Explicit bulk recovery is admitted through the bounded per-host start queue. */
  readonly admission?: 'interactive' | 'bulk'
  readonly resume?: boolean
  readonly harnessSessionId?: string
  /** Explicit user acknowledgment for this profile's current elevated risk. */
  readonly acknowledgeRisk?: boolean
}

export interface HarnessProfilesRequest {
  readonly root: HostPath
}

export interface HarnessProbeProfilesRequest {
  readonly root: HostPath
  readonly profileIds?: readonly HarnessProfileId[]
  readonly force?: boolean
}

export interface HarnessProbeTemplatesRequest {
  readonly root: HostPath
  readonly providerIds?: readonly HarnessProviderId[]
  readonly force?: boolean
}

export interface MaterializeHarnessProfilesRequest {
  readonly root: HostPath
  readonly providerIds: readonly HarnessProviderId[]
}

interface SaveHarnessProfileRequestBase {
  readonly root: HostPath
  readonly input: HarnessProfileInput
}

export type SaveHarnessProfileRequest = SaveHarnessProfileRequestBase &
  (
    | {
        readonly id?: never
        readonly expectedLaunchRevision?: never
        readonly expectedMetadataRevision?: never
      }
    | {
        readonly id: HarnessProfileId
        readonly expectedLaunchRevision: number
        readonly expectedMetadataRevision: number
      }
  )

export interface HarnessProfileRequest {
  readonly id: HarnessProfileId
}

export interface AcknowledgeHarnessProfileRiskRequest {
  readonly root: HostPath
  readonly id: HarnessProfileId
  readonly launchRevision: number
}

interface HarnessPreviewRequestBase {
  readonly root: HostPath
  readonly cwd: HostPath
  readonly mode: 'fresh' | 'resume'
  readonly harnessSessionId?: string
}

export type HarnessPreviewRequest = HarnessPreviewRequestBase &
  (
    | {
        readonly profileId: HarnessProfileId
        readonly launchRevision: number
        readonly input?: never
      }
    | {
        readonly input: HarnessProfileInput
        readonly profileId?: HarnessProfileId
        readonly launchRevision?: never
      }
  )

export interface AuthorizeHarnessPathRequest {
  readonly root: HostPath
  readonly path: HostPath
}

export type ConfigureComposerSubmitRequest =
  | {
      readonly scope: 'host'
      readonly hostId: string
      readonly mode: ComposerSubmitMode
    }
  | {
      readonly scope: 'all-connected'
      readonly mode: ComposerSubmitMode
      readonly previousMode: ComposerSubmitMode
    }

export type StartPtyResponse =
  | {
      readonly outcome: 'started'
      readonly id: string
      readonly pid: number
      readonly resumed: boolean
      readonly harnessSessionId?: string
      readonly identityStatus: TerminalIdentityStatus
      readonly capabilities: import('./harness-provider').HarnessProviderCapabilities
    }
  | {
      readonly outcome: 'resume-unavailable'
      readonly reason: 'artifact-missing'
    }

export type TerminalIdentityStatus =
  'none' | 'discovering' | 'identified' | 'ambiguous' | 'unavailable'

export type TerminalAttentionState = 'working' | 'bell' | 'idle'

export interface TerminalRecoverySession {
  readonly id: string
  readonly providerId: HarnessProviderId
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly recoverySkipCount: 0 | 1
  /** Present only when this terminal explicitly accepted this launch revision. */
  readonly riskAcknowledgedRevision?: number
  readonly artifactIdentity?: string
  readonly harnessSessionId?: string
  readonly hostId: string
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly attention?: TerminalAttentionState
  readonly updatedAt: number
}

export interface TerminalLayoutEntry {
  readonly id: string
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly attention?: TerminalAttentionState
}

export interface TerminalRecoveryRequest {
  readonly root: HostPath
}

export interface RecordTerminalRecoveryDecisionRequest {
  readonly root: HostPath
  readonly restoredIds: readonly string[]
  readonly skippedIds: readonly string[]
}

export interface TerminalLayoutRequest {
  readonly root: HostPath
  readonly sessions: readonly TerminalLayoutEntry[]
}

export interface ForgetTerminalRequest {
  readonly root: HostPath
  readonly id: string
}

export interface PlanTerminalMoveRequest {
  readonly terminalId: string
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
}

export interface TerminalMovePlan {
  readonly terminalId: string
  readonly terminalTitle: string
  readonly sourceProjectId: string
  readonly sourceWorkspaceId: string
  readonly sourceWorkspaceName: string
  readonly sourceRoot: HostPath
  readonly targetWorkspaceId: string
  readonly targetWorkspaceName: string
  readonly targetRoot: HostPath
  readonly webPaneIds: readonly string[]
}

export interface MoveTerminalRequest extends PlanTerminalMoveRequest {
  /** Exact route set shown in the confirmation dialog. */
  readonly expectedWebPaneIds: readonly string[]
}

export interface MoveTerminalResponse {
  readonly state: ProjectState
  readonly workspaceRoot: HostPath
}

export type OpenWebPaneRequest =
  | {
      readonly source: 'terminal'
      readonly root: HostPath
      readonly terminalId: string
      readonly url: string
    }
  | {
      readonly source: 'pane'
      readonly paneId: string
      readonly url: string
    }

export interface OpenWebPaneResponse {
  readonly paneId: string
  readonly partition: string
  readonly url: string
  readonly origin: string
}

export interface CloseWebPaneRequest {
  readonly paneId: string
}

export interface OpenWebPaneExternalRequest {
  readonly paneId: string
  readonly url: string
}

export type OpenWebPaneBrowserRequest = OpenWebPaneExternalRequest

export interface WebPaneBlockedNavigation {
  readonly paneId: string
  readonly kind: 'loopback' | 'external'
  readonly url: string
}

export interface RebindTerminalProfileRequest {
  readonly root: HostPath
  readonly id: string
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly acknowledgeRisk?: boolean
}

/**
 * Request/response channels (renderer invokes, main handles). Add a channel by
 * adding a key here; `IpcInvokeChannel` and the preload bridge follow from it.
 */
export interface IpcInvokeMap {
  'app:info': { request: void; response: AppInfo }
  'workbench-health:get': { request: void; response: WorkbenchHealthSnapshot }
  'workbench-health:acknowledge': {
    request: { readonly occurrenceId: string }
    response: WorkbenchHealthSnapshot
  }
  'diagnostic-evidence:get': {
    request: void
    response: DiagnosticEvidenceState
  }
  'diagnostic-evidence:delete': {
    request: void
    response: DiagnosticEvidenceDeleteResult
  }
  'responsiveness-diagnostics:get': {
    request: void
    response: ResponsivenessDiagnosticsState
  }
  'responsiveness-diagnostics:start': {
    request: void
    response: ResponsivenessDiagnosticsState
  }
  'responsiveness-diagnostics:stop': {
    request: StopResponsivenessDiagnosticsRequest
    response: ResponsivenessDiagnosticsState
  }
  'responsiveness-diagnostics:delete': {
    request: DeleteResponsivenessDiagnosticsRequest
    response: ResponsivenessDiagnosticsState
  }
  'diagnostic-report:create': {
    request: CreateDiagnosticReportRequest
    response: DiagnosticReportStateResult
  }
  'diagnostic-report:capture': {
    request: CaptureDiagnosticReportRequest
    response: DiagnosticReportStateResult
  }
  'diagnostic-report:copy': {
    request: DiagnosticReportIdRequest
    response: DiagnosticReportActionResult
  }
  'diagnostic-report:save': {
    request: DiagnosticReportIdRequest
    response: DiagnosticReportActionResult
  }
  'diagnostic-report:cancel': {
    request: DiagnosticReportIdRequest
    response: DiagnosticReportActionResult
  }
  'diagnostic-report:delete': {
    request: DiagnosticReportIdRequest
    response: DiagnosticReportActionResult
  }
  /** Round-trips text through the echo utility process (renderer→main→worker). */
  'demo:echo': { request: EchoRequest; response: EchoResponse }
  'project:root': { request: void; response: ProjectState }
  'project:hosts': { request: void; response: readonly ProjectHostOption[] }
  'project:connect-host': {
    request: ConnectHostRequest
    response: OperationResult<ConnectedHost>
  }
  'project:disconnect-host': {
    request: DisconnectHostRequest
    response: OperationResult<ProjectHostOption>
  }
  'project:browse-host': {
    request: BrowseHostRequest
    response: OperationResult<BrowseHostResponse>
  }
  'project:open': {
    request: OpenProjectRequest
    response: OperationResult<ProjectState>
  }
  'project:switch': {
    request: SwitchWorkspaceRequest
    response: OperationResult<ProjectState>
  }
  'project:refresh': {
    request: RefreshProjectRequest
    response: OperationResult<ProjectState>
  }
  'project:watch-interests': {
    request: ProjectWatchInterestsRequest
    response: OperationResult<ProjectWatchInterestsResponse>
  }
  'project:close': {
    request: CloseProjectRequest
    response: OperationResult<ProjectState>
  }
  'workspace:prune': {
    request: PruneProjectWorktreesRequest
    response: OperationResult<ProjectState>
  }
  'workspace:dismiss': {
    request: DismissWorkspaceRequest
    response: OperationResult<ProjectState>
  }
  'workspace:acknowledge': {
    request: AcknowledgeWorkspaceRequest
    response: OperationResult<ProjectState>
  }
  'ssh:prompt-response': { request: SshPromptResponse; response: void }
  'fs:readdir': {
    request: ReadDirectoryRequest
    response: OperationResult<readonly DirEntry[]>
  }
  'fs:resolve-entry': {
    request: ReadFileRequest
    response: OperationResult<ResolveEntryResponse>
  }
  'fs:read': { request: ReadFileRequest; response: OperationResult<ReadFileResponse> }
  'fs:read-asset': {
    request: ReadFileRequest
    response: OperationResult<ReadAssetResponse>
  }
  'fs:write': { request: WriteFileRequest; response: OperationResult<WriteFileResponse> }
  'git:diff-inputs': { request: GitDiffRequest; response: GitDiffResponse }
  'git:changes': { request: GitChangesRequest; response: GitChanges }
  'git:history': { request: GitHistoryRequest; response: GitHistoryPage }
  'git:ignored-entries': {
    request: GitIgnoredEntriesRequest
    response: GitIgnoredEntriesResponse
  }
  'git:commit-detail': { request: GitCommitDetailRequest; response: GitCommitDetail }
  'git:blame': { request: GitBlameRequest; response: readonly GitBlameRun[] }
  'git:branches': { request: GitChangesRequest; response: GitBranchModel }
  'git:fetch': {
    request: GitFetchRequest
    response: OperationResult<ProjectState>
  }
  'git:pull': {
    request: GitPullRequest
    response: OperationResult<ProjectState>
  }
  'git:switch-branch': {
    request: GitSwitchBranchRequest
    response: OperationResult<ProjectState>
  }
  'html-preview:create': {
    request: CreateHtmlPreviewRequest
    response: CreateHtmlPreviewResponse
  }
  'harness:catalog': { request: void; response: readonly HarnessProviderDescriptor[] }
  'harness:profiles': {
    request: HarnessProfilesRequest
    response: readonly HarnessProfile[]
  }
  'harness:probe-snapshot': {
    request: HarnessProfilesRequest
    response: readonly HarnessProfileProbe[]
  }
  'harness:probe-profiles': {
    request: HarnessProbeProfilesRequest
    response: readonly HarnessProfileProbe[]
  }
  'harness:probe-templates': {
    request: HarnessProbeTemplatesRequest
    response: readonly HarnessProfileProbe[]
  }
  'harness:profile-materialize': {
    request: MaterializeHarnessProfilesRequest
    response: readonly HarnessProfile[]
  }
  'harness:profile-save': {
    request: SaveHarnessProfileRequest
    response: HarnessProfile
  }
  'harness:profile-duplicate': {
    request: HarnessProfileRequest
    response: HarnessProfile
  }
  'harness:profile-delete': { request: HarnessProfileRequest; response: void }
  'harness:acknowledge-risk': {
    request: AcknowledgeHarnessProfileRiskRequest
    response: HarnessProfile
  }
  'harness:preview': {
    request: HarnessPreviewRequest
    response: HarnessCommandPreview
  }
  'harness:authorize-path': {
    request: AuthorizeHarnessPathRequest
    response: HarnessPathGrant
  }
  'harness:configure-composer-submit': {
    request: ConfigureComposerSubmitRequest
    response: void
  }
  'terminal:recovery': {
    request: TerminalRecoveryRequest
    response: readonly TerminalRecoverySession[]
  }
  'terminal:record-recovery-decision': {
    request: RecordTerminalRecoveryDecisionRequest
    response: void
  }
  'terminal:update-layout': { request: TerminalLayoutRequest; response: void }
  'terminal:forget': { request: ForgetTerminalRequest; response: void }
  'terminal:plan-move': {
    request: PlanTerminalMoveRequest
    response: OperationResult<TerminalMovePlan>
  }
  'terminal:move': {
    request: MoveTerminalRequest
    response: OperationResult<MoveTerminalResponse>
  }
  'terminal:rebind-profile': {
    request: RebindTerminalProfileRequest
    response: TerminalRecoverySession
  }
  'pty:start': { request: StartPtyRequest; response: StartPtyResponse }
  'web-pane:open': {
    request: OpenWebPaneRequest
    response: OperationResult<OpenWebPaneResponse>
  }
  'web-pane:close': { request: CloseWebPaneRequest; response: void }
  'web-pane:open-external': { request: OpenWebPaneExternalRequest; response: void }
  'web-pane:open-browser': { request: OpenWebPaneBrowserRequest; response: void }
}

/**
 * Fire-and-forget renderer -> main channels. PTY input uses this path so a
 * round trip is never inserted into the typing hot path.
 */
export interface IpcSendMap {
  'app:renderer-ready': void
  'diagnostics:render-containment': RenderContainmentDiagnosticBatch
  'diagnostics:responsiveness-observation': ResponsivenessObservationBatch
  'html-preview:release': ReleaseHtmlPreviewRequest
  'pty:write': { readonly id: string; readonly data: string }
  'pty:resize': { readonly id: string; readonly cols: number; readonly rows: number }
  'pty:kill': { readonly id: string }
  'app:attention': { readonly count: number }
  'web-pane:reserved-bindings': KeybindingMap
  'web-pane:full-page': { readonly paneId?: string }
}

/** Main -> renderer push channels. */
export interface IpcEventMap {
  'diagnostics:session': RendererDiagnosticSession
  'workbench-health:state': WorkbenchHealthSnapshot
  'project:watch': WatchEvent
  'project:state': ProjectState
  'ssh:prompt': SshPromptRequest
  'ssh:prompt-cancel': { readonly hostId: string }
  'pty:data': { readonly id: string; readonly data: string }
  'pty:exit': { readonly id: string; readonly exitCode: number; readonly signal?: number }
  'pty:telemetry': {
    readonly id: string
    readonly telemetry: HarnessTelemetry | undefined
  }
  'pty:identity': {
    readonly id: string
    readonly harnessSessionId?: string
    readonly identityStatus: TerminalIdentityStatus
  }
  'web-pane:navigation-blocked': WebPaneBlockedNavigation
  'web-pane:command': {
    readonly paneId: string
    readonly action: WebPaneCommandAction
  }
  'web-pane:diagnostic': {
    readonly paneId: string
    readonly event: WebPaneDiagnosticEvent
  }
}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcSendChannel = keyof IpcSendMap
export type IpcEventChannel = keyof IpcEventMap

export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C]['request']
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C]['response']
export type IpcSendPayload<C extends IpcSendChannel> = IpcSendMap[C]
export type IpcEventPayload<E extends IpcEventChannel> = IpcEventMap[E]

/**
 * The surface exposed to the renderer as `window.hvir` (via the preload
 * bridge). Defined here — a pure, electron-free type — so the renderer can type
 * against it without importing anything from main/preload.
 */
export interface HvirApi {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>>
  send<C extends IpcSendChannel>(channel: C, payload: IpcSendPayload<C>): void
  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ): Disposer
  readonly diagnostics: {
    /** Domain-owned, content-free evidence. Invalid or overloaded calls are dropped. */
    recordRenderContainment(occurrenceId: string): void
    /** Content-free responsiveness evidence routed through the bounded preload queue. */
    recordResponsivenessObservation(observation: ResponsivenessObservation): void
    /** Flush queued observations before an explicit session transition. */
    flushResponsivenessObservations(): void
  }
}

/**
 * Runtime allow-list of invokable channels. The preload bridge validates
 * against this so the renderer can never reach an un-declared channel.
 */
export const INVOKE_CHANNELS = [
  'app:info',
  'workbench-health:get',
  'workbench-health:acknowledge',
  'diagnostic-evidence:get',
  'diagnostic-evidence:delete',
  'responsiveness-diagnostics:get',
  'responsiveness-diagnostics:start',
  'responsiveness-diagnostics:stop',
  'responsiveness-diagnostics:delete',
  'diagnostic-report:create',
  'diagnostic-report:capture',
  'diagnostic-report:copy',
  'diagnostic-report:save',
  'diagnostic-report:cancel',
  'diagnostic-report:delete',
  'demo:echo',
  'project:root',
  'project:hosts',
  'project:connect-host',
  'project:disconnect-host',
  'project:browse-host',
  'project:open',
  'project:switch',
  'project:refresh',
  'project:watch-interests',
  'project:close',
  'workspace:prune',
  'workspace:dismiss',
  'workspace:acknowledge',
  'ssh:prompt-response',
  'fs:readdir',
  'fs:resolve-entry',
  'fs:read',
  'fs:read-asset',
  'fs:write',
  'git:diff-inputs',
  'git:changes',
  'git:history',
  'git:ignored-entries',
  'git:commit-detail',
  'git:blame',
  'git:branches',
  'git:fetch',
  'git:pull',
  'git:switch-branch',
  'html-preview:create',
  'harness:catalog',
  'harness:profiles',
  'harness:probe-snapshot',
  'harness:probe-profiles',
  'harness:probe-templates',
  'harness:profile-materialize',
  'harness:profile-save',
  'harness:profile-duplicate',
  'harness:profile-delete',
  'harness:acknowledge-risk',
  'harness:preview',
  'harness:authorize-path',
  'harness:configure-composer-submit',
  'terminal:recovery',
  'terminal:record-recovery-decision',
  'terminal:update-layout',
  'terminal:forget',
  'terminal:plan-move',
  'terminal:move',
  'terminal:rebind-profile',
  'pty:start',
  'web-pane:open',
  'web-pane:close',
  'web-pane:open-external',
  'web-pane:open-browser',
] as const satisfies readonly IpcInvokeChannel[]

export const SEND_CHANNELS = [
  'app:renderer-ready',
  'diagnostics:render-containment',
  'diagnostics:responsiveness-observation',
  'html-preview:release',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'app:attention',
  'web-pane:reserved-bindings',
  'web-pane:full-page',
] as const satisfies readonly IpcSendChannel[]

export const EVENT_CHANNELS = [
  'diagnostics:session',
  'workbench-health:state',
  'project:watch',
  'project:state',
  'ssh:prompt',
  'ssh:prompt-cancel',
  'pty:data',
  'pty:exit',
  'pty:telemetry',
  'pty:identity',
  'web-pane:navigation-blocked',
  'web-pane:command',
  'web-pane:diagnostic',
] as const satisfies readonly IpcEventChannel[]

// Compile-time proof that INVOKE_CHANNELS stays in sync with IpcInvokeMap.
type _AssertChannelsCover = IpcInvokeChannel extends (typeof INVOKE_CHANNELS)[number]
  ? true
  : ['INVOKE_CHANNELS is missing a channel declared in IpcInvokeMap']
const _channelsCover: _AssertChannelsCover = true
void _channelsCover

type _AssertSendChannelsCover = IpcSendChannel extends (typeof SEND_CHANNELS)[number]
  ? true
  : ['SEND_CHANNELS is missing a channel declared in IpcSendMap']
const _sendChannelsCover: _AssertSendChannelsCover = true
void _sendChannelsCover

type _AssertEventChannelsCover = IpcEventChannel extends (typeof EVENT_CHANNELS)[number]
  ? true
  : ['EVENT_CHANNELS is missing a channel declared in IpcEventMap']
const _eventChannelsCover: _AssertEventChannelsCover = true
void _eventChannelsCover
