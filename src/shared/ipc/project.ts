import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type DirEntry,
  type WatchEvent,
  type HostConnectionState,
  type HostWatchTier,
} from '../fs-types'
import { type HostPath } from '../host-path'
import { type ProjectState } from '../workspace-types'
import { type OperationResult } from '../operation-result'

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

export type PlanWorkspaceCloseRequest = SwitchWorkspaceRequest

export interface WorkspaceClosePlan {
  readonly terminalCount: number
}

export interface CloseWorkspaceRequest extends SwitchWorkspaceRequest {
  readonly expectedTerminalCount: number
  readonly terminateTerminals: boolean
}

export type ReopenWorkspaceRequest = SwitchWorkspaceRequest

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

export interface ProjectFolderPickerStartRequest {
  readonly hostId: string
}

export interface ProjectFolderPickerLease {
  readonly pickerId: string
}

export interface ProjectFolderPickerBrowseRequest {
  readonly pickerId: string
  readonly path: string
}

export interface ProjectFolderPickerCreateDirectoryRequest {
  readonly pickerId: string
  readonly destinationParent: HostPath
  readonly name: string
}

export interface ProjectFolderPickerCloseRequest {
  readonly pickerId: string
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

export const projectIpc = {
  invoke: {
    'project:root': invoke<void, ProjectState>(),
    'project:hosts': invoke<void, readonly ProjectHostOption[]>(),
    'project:connect-host': invoke<ConnectHostRequest, OperationResult<ConnectedHost>>(),
    'project:disconnect-host': invoke<
      DisconnectHostRequest,
      OperationResult<ProjectHostOption>
    >(),
    'project:browse-host': invoke<
      BrowseHostRequest,
      OperationResult<BrowseHostResponse>
    >(),
    'project:folder-picker-start': invoke<
      ProjectFolderPickerStartRequest,
      OperationResult<ProjectFolderPickerLease>
    >(),
    'project:folder-picker-browse': invoke<
      ProjectFolderPickerBrowseRequest,
      OperationResult<BrowseHostResponse>
    >(),
    'project:folder-picker-create-directory': invoke<
      ProjectFolderPickerCreateDirectoryRequest,
      OperationResult<HostPath>
    >(),
    'project:folder-picker-close': invoke<
      ProjectFolderPickerCloseRequest,
      OperationResult<void>
    >(),
    'project:open': invoke<OpenProjectRequest, OperationResult<ProjectState>>(),
    'project:switch': invoke<SwitchWorkspaceRequest, OperationResult<ProjectState>>(),
    'project:refresh': invoke<RefreshProjectRequest, OperationResult<ProjectState>>(),
    'project:watch-interests': invoke<
      ProjectWatchInterestsRequest,
      OperationResult<ProjectWatchInterestsResponse>
    >(),
    'project:close': invoke<CloseProjectRequest, OperationResult<ProjectState>>(),
    'workspace:prune': invoke<
      PruneProjectWorktreesRequest,
      OperationResult<ProjectState>
    >(),
    'workspace:dismiss': invoke<DismissWorkspaceRequest, OperationResult<ProjectState>>(),
    'workspace:plan-close': invoke<
      PlanWorkspaceCloseRequest,
      OperationResult<WorkspaceClosePlan>
    >(),
    'workspace:close': invoke<CloseWorkspaceRequest, OperationResult<ProjectState>>(),
    'workspace:reopen': invoke<ReopenWorkspaceRequest, OperationResult<ProjectState>>(),
    'workspace:acknowledge': invoke<
      AcknowledgeWorkspaceRequest,
      OperationResult<ProjectState>
    >(),
    'ssh:prompt-response': invoke<SshPromptResponse, void>(),
  },
  send: {},
  event: {
    'project:watch': payload<WatchEvent>(),
    'project:state': payload<ProjectState>(),
    'ssh:prompt': payload<SshPromptRequest>(),
    'ssh:prompt-cancel': payload<{ readonly hostId: string }>(),
  },
} satisfies IpcFeatureContract
