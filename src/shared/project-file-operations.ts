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
  readonly phase: 'copying' | 'cancelling' | 'completed'
  readonly completedItems: number
  readonly totalItems: number
  readonly currentName?: string
  readonly result?: ProjectFileOperationResult
}

export type ProjectFileItemStatus =
  'completed' | 'skipped' | 'conflicted' | 'cancelled' | 'failed'

export type ProjectFileEffect =
  'none' | 'created-file' | 'created-directory' | 'copied-file' | 'copied-directory'

export interface ProjectFileItemResult {
  readonly itemId: string
  readonly destination: HostPath
  readonly status: ProjectFileItemStatus
  readonly effect: ProjectFileEffect
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
