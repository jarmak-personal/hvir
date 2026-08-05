import type { HostPath } from './host-path'

export type ProjectFileCreateKind = 'file' | 'directory'

export interface ProjectFileCreateRequest {
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: ProjectFileCreateKind
}

export interface ExternalFileGrantDescriptor {
  readonly grantId: string
  readonly generation: number
  readonly items: readonly ExternalFileGrantItemDescriptor[]
}

export interface ExternalFileGrantItemDescriptor {
  readonly itemId: string
  readonly name: string
  readonly type: 'file' | 'directory' | 'unsupported'
  readonly reason?: string
}

export type ExternalFileGrantResult =
  | {
      readonly outcome: 'available'
      readonly grant: ExternalFileGrantDescriptor
    }
  | {
      readonly outcome: 'unsupported'
      readonly reason: string
    }

export interface ProjectFileExternalCopyRequest {
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly grantId: string
  readonly grantGeneration: number
}

export type ProjectFileOrganizationRequest =
  | {
      readonly action: 'rename'
      readonly workspaceRoot: HostPath
      readonly source: HostPath
      readonly name: string
    }
  | {
      readonly action: 'move'
      readonly workspaceRoot: HostPath
      readonly source: HostPath
      readonly destinationDirectory: HostPath
    }
  | {
      readonly action: 'duplicate'
      readonly workspaceRoot: HostPath
      readonly source: HostPath
      readonly destinationDirectory: HostPath
      readonly name: string
    }

export type ProjectFileDeletionRecovery = 'recoverable' | 'permanent'

export interface ProjectFileDeletionDisclosureRequest {
  readonly workspaceRoot: HostPath
  readonly source: HostPath
}

export type ProjectFileDeletionDisclosure =
  | {
      readonly outcome: 'available'
      readonly workspaceRoot: HostPath
      readonly source: HostPath
      readonly recovery: ProjectFileDeletionRecovery
    }
  | {
      readonly outcome: 'unavailable'
      readonly workspaceRoot: HostPath
      readonly source: HostPath
      readonly reason: string
    }

export interface ProjectFileDeleteRequest {
  readonly workspaceRoot: HostPath
  readonly source: HostPath
  /** The exact recovery guarantee reviewed in the confirmation dialog. */
  readonly confirmedRecovery: ProjectFileDeletionRecovery
}

export interface ProjectFileCancelRequest {
  readonly operationId: string
  readonly generation: number
}

export type ProjectFileOperationStartResult =
  | {
      readonly outcome: 'started'
      readonly operationId: string
      readonly generation: number
      readonly itemCount: number
    }
  | {
      readonly outcome: 'busy'
      readonly reason: string
    }

export interface ProjectFileOperationProgress {
  readonly workspaceRoot: HostPath
  readonly operationId: string
  readonly generation: number
  readonly phase:
    | 'copying'
    | 'renaming'
    | 'moving'
    | 'duplicating'
    | 'deleting'
    | 'cancelling'
    | 'completed'
  readonly completedItems: number
  readonly totalItems: number
  readonly currentName?: string
  readonly result?: ProjectFileOperationResult
}

export type ProjectFileItemStatus =
  'completed' | 'skipped' | 'conflicted' | 'cancelled' | 'failed'

export type ProjectFileEffect =
  | 'none'
  | 'created-file'
  | 'created-directory'
  | 'copied-file'
  | 'copied-directory'
  | 'renamed-entry'
  | 'moved-entry'
  | 'duplicated-file'
  | 'duplicated-directory'
  | 'trashed-entry'
  | 'permanently-deleted-entry'
  | 'partially-deleted-entry'
  | 'deletion-state-unknown'

export interface ProjectFileSourceDisposition {
  readonly outcome: 'retained' | 'removed' | 'partially-removed' | 'unknown'
  /** Observed source/recovery path; `unknown` does not assert that it still exists. */
  readonly path?: HostPath
  readonly removedEntries?: number
  readonly totalEntries?: number
}

export interface ProjectFileItemResult {
  readonly itemId: string
  readonly source?: HostPath
  readonly destination: HostPath
  readonly status: ProjectFileItemStatus
  readonly effect: ProjectFileEffect
  readonly sourceDisposition?: ProjectFileSourceDisposition
  readonly reason?: string
}

export type ProjectFileOperationResult =
  | {
      readonly outcome: 'completed'
      readonly operationId: string
      readonly generation: number
      readonly items: readonly ProjectFileItemResult[]
    }
  | {
      readonly outcome: 'busy'
      readonly reason: string
      readonly items: readonly []
    }

export function isProjectFileEntryName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\')
  )
}
