import {
  joinHostPath,
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
import { moveExternalFileGrant } from './external-file-move'
import {
  boundedProjectFileReason,
  proveRealProjectDirectory,
} from './project-file-confinement'
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
  const { input, runtime } = options
  const identity = await runtime.prepare(input.owner, input.workspaceRoot)
  const canonicalDestinationDirectory = await proveRealProjectDirectory(
    identity.host,
    identity.workspaceRoot,
    identity.canonicalRoot,
    input.destinationDirectory,
  )
  const stagingReservation = options.stagingCleanup.reserve(identity.host)
  if (!stagingReservation) {
    return {
      outcome: 'busy',
      reason: 'Pending staging cleanup has reached the host safety limit',
    }
  }
  let grant
  try {
    grant = options.externalFiles.consume(
      input.owner,
      input.grantId,
      input.grantGeneration,
      'move',
    )
  } catch (reason) {
    stagingReservation.release()
    throw reason
  }
  let admission
  try {
    admission = runtime.activate(identity, input.publish, grant.items.length)
  } catch (reason) {
    grant.revoke()
    stagingReservation.release()
    throw reason
  }
  if (admission.outcome === 'busy') {
    grant.revoke()
    stagingReservation.release()
    return admission
  }
  const { operation } = admission
  runtime.launch(
    operation,
    () =>
      moveExternalFileGrant({
        operationId: identity.operationId,
        generation: identity.generation,
        visibleDestinationDirectory: input.destinationDirectory,
        canonicalDestinationDirectory,
        destinationHost: identity.host,
        grant,
        signal: operation.abort.signal,
        assertCurrent: () => {
          runtime.assertCurrent(identity, operation.abort.signal)
          grant.assertCurrent()
        },
        revalidateDestinationDirectory: () =>
          proveRealProjectDirectory(
            identity.host,
            identity.workspaceRoot,
            identity.canonicalRoot,
            input.destinationDirectory,
          ),
        limits: options.limits,
        createStagingId: options.createStagingId,
        cleanupStaging: (host, path) => options.stagingCleanup.cleanup(host, path),
        onProgress: (completedItems, totalItems, currentName) => {
          operation.latestCompletedItems = completedItems
          runtime.publish(operation, {
            workspaceRoot: identity.workspaceRoot,
            operationId: identity.operationId,
            generation: identity.generation,
            phase: operation.abort.signal.aborted ? 'cancelling' : 'moving-external',
            completedItems,
            totalItems,
            ...(currentName ? { currentName } : {}),
          })
        },
      }),
    (failure) => {
      const reason = boundedProjectFileReason(
        operation.abort.signal.reason ?? failure,
        'The external move operation stopped unexpectedly',
      )
      return {
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: grant.items.map((item) => ({
          itemId: item.itemId,
          ...(item.source
            ? {
                source: item.source,
                sourceDisposition: {
                  outcome: 'unknown' as const,
                  path: item.source,
                },
              }
            : {}),
          destination: joinHostPath(input.destinationDirectory, item.name),
          status: 'failed' as const,
          effect: 'external-move-state-unknown' as const,
          reason,
        })),
      }
    },
    () => {
      grant.revoke()
      stagingReservation.release()
    },
  )
  return {
    outcome: 'started',
    operationId: identity.operationId,
    generation: identity.generation,
    itemCount: grant.items.length,
  }
}
