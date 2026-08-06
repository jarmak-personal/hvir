import {
  joinHostPath,
  type ExternalFileGrantPurpose,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOperationStartResult,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ProjectHost } from '../project-host'
import type {
  ExternalFileGrantRegistry,
  ExternalFileGrantUse,
  GrantedExternalFileItem,
} from './external-file-grants'
import {
  boundedProjectFileReason,
  proveRealProjectDirectory,
} from './project-file-confinement'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'
import type {
  ProjectFileOperationRuntime,
  ProjectFileOperationIdentity,
} from './project-file-operation-runtime'
import type { ProjectFileStagingCleanup } from './staging-cleanup'

export interface ExternalFileOperationExecution {
  readonly operationId: string
  readonly generation: number
  readonly visibleDestinationDirectory: HostPath
  readonly canonicalDestinationDirectory: HostPath
  readonly destinationHost: ProjectHost
  readonly grant: ExternalFileGrantUse
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly revalidateDestinationDirectory: () => Promise<HostPath>
  readonly limits: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly cleanupStaging: (host: ProjectHost, path: HostPath) => Promise<void>
  readonly onProgress: (
    completedItems: number,
    totalItems: number,
    currentName?: string,
  ) => void
}

export interface ExternalFileOperationFallback {
  readonly item: GrantedExternalFileItem
  readonly destination: HostPath
  readonly reason: string
  readonly aborted: boolean
}

/** Shared authority and lifecycle owner for external copy and move operations. */
export async function startExternalFileOperation(options: {
  readonly runtime: ProjectFileOperationRuntime
  readonly externalFiles: ExternalFileGrantRegistry
  readonly stagingCleanup: ProjectFileStagingCleanup
  readonly limits: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly purpose: ExternalFileGrantPurpose
  readonly phase: Extract<
    ProjectFileOperationProgress['phase'],
    'copying' | 'moving-external'
  >
  readonly failureReason: string
  readonly input: {
    readonly owner: RendererOwner
    readonly workspaceRoot: HostPath
    readonly destinationDirectory: HostPath
    readonly grantId: string
    readonly grantGeneration: number
    readonly publish: (progress: ProjectFileOperationProgress) => void
  }
  readonly execute: (
    execution: ExternalFileOperationExecution,
  ) => Promise<ProjectFileOperationResult>
  readonly fallbackItem: (
    fallback: ExternalFileOperationFallback,
  ) => ProjectFileItemResult
}): Promise<ProjectFileOperationStartResult> {
  const { input, runtime } = options
  const identity = await runtime.prepare(input.owner, input.workspaceRoot)
  const canonicalDestinationDirectory = await proveRealProjectDirectory(
    identity.host,
    identity.workspaceRoot,
    identity.canonicalRoot,
    input.destinationDirectory,
  )
  const itemCount = options.externalFiles.availableItemCount(
    input.owner,
    input.grantId,
    input.grantGeneration,
    options.purpose,
  )
  const stagingReservation = options.stagingCleanup.reserve(identity.host, itemCount)
  if (!stagingReservation) {
    return {
      outcome: 'busy',
      reason: 'Pending staging cleanup has reached the host safety limit',
    }
  }
  let grant: ExternalFileGrantUse
  try {
    grant =
      options.purpose === 'move'
        ? options.externalFiles.consume(
            input.owner,
            input.grantId,
            input.grantGeneration,
            'move',
          )
        : options.externalFiles.consume(
            input.owner,
            input.grantId,
            input.grantGeneration,
            'copy',
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
      options.execute({
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
        cleanupStaging: (host, path) => {
          if (host !== identity.host) {
            return Promise.reject(new Error('Staging cleanup host changed'))
          }
          return stagingReservation.cleanup(path)
        },
        onProgress: (completedItems, totalItems, currentName) => {
          operation.latestCompletedItems = completedItems
          runtime.publish(operation, {
            workspaceRoot: identity.workspaceRoot,
            operationId: identity.operationId,
            generation: identity.generation,
            phase: operation.abort.signal.aborted ? 'cancelling' : options.phase,
            completedItems,
            totalItems,
            ...(currentName ? { currentName } : {}),
          })
        },
      }),
    (failure) => terminalFailure(options, identity, grant, operation.abort, failure),
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

function terminalFailure(
  options: Parameters<typeof startExternalFileOperation>[0],
  identity: ProjectFileOperationIdentity,
  grant: ExternalFileGrantUse,
  abort: AbortController,
  failure: unknown,
): ProjectFileOperationResult {
  const reason = boundedProjectFileReason(
    abort.signal.reason ?? failure,
    options.failureReason,
  )
  return {
    outcome: 'completed',
    operationId: identity.operationId,
    generation: identity.generation,
    items: grant.items.map((item) =>
      options.fallbackItem({
        item,
        destination: joinHostPath(options.input.destinationDirectory, item.name),
        reason,
        aborted: abort.signal.aborted,
      }),
    ),
  }
}
