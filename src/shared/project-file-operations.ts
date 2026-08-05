import type { HostPath } from './host-path'

export type ProjectFileCreateKind = 'file' | 'directory'

export interface ProjectFileCreateRequest {
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: ProjectFileCreateKind
}

export type ProjectFileItemStatus =
  'completed' | 'skipped' | 'conflicted' | 'cancelled' | 'failed'

export type ProjectFileEffect = 'none' | 'created-file' | 'created-directory'

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
