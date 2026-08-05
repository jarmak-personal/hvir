import {
  type ExternalMoveGrantResult,
  type ExternalMovePickerSelection,
  type HostPath,
  type ProjectFileExternalMoveDisclosure,
  type ProjectFileOperationProgress,
  type ProjectFileOperationStartResult,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExternalMovePickerPort } from './electron-external-move-picker'
import type { ExternalFileGrantRegistry } from './external-file-grants'
import { startExternalFileOperation } from './external-file-operation'
import { boundedExternalMoveReason, moveExternalFileGrant } from './external-file-move'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'
import type { ProjectFileOperationRuntime } from './project-file-operation-runtime'
import type { ProjectFileStagingCleanup } from './staging-cleanup'

export function discloseExternalMove(
  runtime: ProjectFileOperationRuntime,
  externalFiles: ExternalFileGrantRegistry,
  picker: ExternalMovePickerPort | undefined,
  owner: RendererOwner,
): ProjectFileExternalMoveDisclosure {
  runtime.assertRenderer(owner)
  if (!picker) {
    return {
      outcome: 'unavailable',
      reason: 'The application-host native picker is unavailable',
    }
  }
  if (!externalFiles.supportsExternalMove) {
    return {
      outcome: 'unavailable',
      reason: 'Recoverable application-host Trash is unavailable',
    }
  }
  return { outcome: 'available', picker: picker.policy, recovery: 'recoverable' }
}

export async function acquireExternalMove(
  runtime: ProjectFileOperationRuntime,
  externalFiles: ExternalFileGrantRegistry,
  picker: ExternalMovePickerPort | undefined,
  owner: RendererOwner,
  selection: ExternalMovePickerSelection,
): Promise<ExternalMoveGrantResult> {
  const disclosure = discloseExternalMove(runtime, externalFiles, picker, owner)
  if (disclosure.outcome !== 'available') throw new Error(disclosure.reason)
  if (
    disclosure.picker.kind === 'mixed-multiple'
      ? selection !== 'mixed'
      : selection === 'mixed'
  ) {
    throw new Error('Invalid native selection mode for this platform')
  }
  const paths = await picker!.pick(selection)
  runtime.assertRenderer(owner)
  return paths ? externalFiles.acquire(owner, paths, 'move') : { outcome: 'cancelled' }
}

export async function startExternalMove(options: {
  readonly runtime: ProjectFileOperationRuntime
  readonly externalFiles: ExternalFileGrantRegistry
  readonly stagingCleanup: ProjectFileStagingCleanup
  readonly limits: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly input: {
    readonly owner: RendererOwner
    readonly workspaceRoot: HostPath
    readonly destinationDirectory: HostPath
    readonly grantId: string
    readonly grantGeneration: number
    readonly publish: (progress: ProjectFileOperationProgress) => void
  }
}): Promise<ProjectFileOperationStartResult> {
  return startExternalFileOperation({
    ...options,
    purpose: 'move',
    phase: 'moving-external',
    failureReason: 'The external move operation stopped unexpectedly',
    execute: (execution) => {
      if (execution.grant.purpose !== 'move') {
        throw new Error('External move received a non-move grant')
      }
      return moveExternalFileGrant({ ...execution, grant: execution.grant })
    },
    fallbackItem: ({ item, destination, reason }) => ({
      itemId: item.itemId,
      destination,
      status: 'failed',
      effect: 'external-move-state-unknown',
      ...(item.source ? { sourceDisposition: { outcome: 'unknown' as const } } : {}),
      reason: boundedExternalMoveReason(
        reason,
        'The external move operation stopped unexpectedly',
        item.source,
      ),
    }),
  })
}
