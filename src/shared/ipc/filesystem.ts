import { invoke, preloadInvoke, payload, type IpcFeatureContract } from '../ipc-contract'
import { type DirEntry, type FileType } from '../fs-types'
import {
  type FilenameSearchRequest,
  type FilenameSearchResponse,
} from '../filename-search'
import { type HostPath } from '../host-path'
import {
  type ExternalFileGrantResult,
  type ExternalMoveGrantResult,
  type ExternalMoveGrantReleaseRequest,
  type ProjectFileExternalMoveAcquireRequest,
  type ProjectFileExternalMoveDisclosure,
  type ProjectFileExternalMoveRequest,
  type ProjectFileCreateRequest,
  type ProjectFileDeleteRequest,
  type ProjectFileDeletionDisclosure,
  type ProjectFileDeletionDisclosureRequest,
  type ProjectFileCancelRequest,
  type ProjectFileExternalCopyRequest,
  type ProjectFileOrganizationRequest,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOperationStartResult,
} from '../project-file-operations'
import { type WriteFileRequest, type WriteFileResponse } from '../viewer-types'
import { type OperationResult } from '../operation-result'

export interface ReadDirectoryRequest {
  readonly path: HostPath
}

export interface ReadFileRequest {
  readonly path: HostPath
}

export interface RevealProjectEntryRequest {
  readonly workspaceRoot: HostPath
  readonly path: HostPath
}

/** Preload-only payload populated through Electron's disk-backed File bridge. */
export interface AcquireDroppedFilesRequest {
  readonly paths: readonly string[]
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

export const filesystemIpc = {
  invoke: {
    'fs:readdir': invoke<ReadDirectoryRequest, OperationResult<readonly DirEntry[]>>(),
    'fs:filename-search': invoke<
      FilenameSearchRequest,
      OperationResult<FilenameSearchResponse>
    >(),
    'fs:resolve-entry': invoke<ReadFileRequest, OperationResult<ResolveEntryResponse>>(),
    'fs:reveal-entry': invoke<RevealProjectEntryRequest, OperationResult<void>>(),
    'fs:read': invoke<ReadFileRequest, OperationResult<ReadFileResponse>>(),
    'fs:read-asset': invoke<ReadFileRequest, OperationResult<ReadAssetResponse>>(),
    'fs:write': invoke<WriteFileRequest, OperationResult<WriteFileResponse>>(),
    'fs:create-entry': invoke<
      ProjectFileCreateRequest,
      OperationResult<ProjectFileOperationResult>
    >(),
    'fs:acquire-clipboard-files': invoke<
      void,
      OperationResult<ExternalFileGrantResult>
    >(),
    'fs:acquire-dropped-files': preloadInvoke<
      AcquireDroppedFilesRequest,
      OperationResult<ExternalFileGrantResult>
    >(),
    'fs:copy-external': invoke<
      ProjectFileExternalCopyRequest,
      OperationResult<ProjectFileOperationStartResult>
    >(),
    'fs:external-move-disclosure': invoke<
      void,
      OperationResult<ProjectFileExternalMoveDisclosure>
    >(),
    'fs:acquire-external-move-files': invoke<
      ProjectFileExternalMoveAcquireRequest,
      OperationResult<ExternalMoveGrantResult>
    >(),
    'fs:release-external-move-grant': invoke<
      ExternalMoveGrantReleaseRequest,
      OperationResult<boolean>
    >(),
    'fs:move-external': invoke<
      ProjectFileExternalMoveRequest,
      OperationResult<ProjectFileOperationStartResult>
    >(),
    'fs:organize-entry': invoke<
      ProjectFileOrganizationRequest,
      OperationResult<ProjectFileOperationStartResult>
    >(),
    'fs:deletion-disclosure': invoke<
      ProjectFileDeletionDisclosureRequest,
      OperationResult<ProjectFileDeletionDisclosure>
    >(),
    'fs:delete-entry': invoke<
      ProjectFileDeleteRequest,
      OperationResult<ProjectFileOperationStartResult>
    >(),
    'fs:cancel-file-operation': invoke<
      ProjectFileCancelRequest,
      OperationResult<boolean>
    >(),
  },
  send: {
    'fs:filename-search-cancel': payload<{ readonly requestId: number }>(),
  },
  event: {
    'fs:project-file-operation': payload<ProjectFileOperationProgress>(),
  },
} satisfies IpcFeatureContract
