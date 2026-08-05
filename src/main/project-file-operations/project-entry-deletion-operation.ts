import {
  hostPathEquals,
  type HostPath,
  type ProjectFileDeleteRequest,
  type ProjectFileDeletionDisclosure,
  type ProjectFileOperationProgress,
  type ProjectFileOperationStartResult,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import { deleteProjectEntry } from './delete-project-entry'
import { boundedProjectFileReason, proveProjectEntry } from './project-file-confinement'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'
import type { ProjectFileOperationRuntime } from './project-file-operation-runtime'

export interface ProjectFileDeletionInput {
  readonly owner: RendererOwner
  readonly request: ProjectFileDeleteRequest
  readonly publish: (progress: ProjectFileOperationProgress) => void
}

export async function discloseProjectEntryDeletion(
  runtime: ProjectFileOperationRuntime,
  owner: RendererOwner,
  workspaceRoot: HostPath,
  source: HostPath,
): Promise<ProjectFileDeletionDisclosure> {
  const identity = await runtime.prepare(owner, workspaceRoot)
  if (hostPathEquals(source, workspaceRoot)) {
    return {
      outcome: 'unavailable',
      workspaceRoot,
      source,
      reason: 'The workspace root cannot be deleted',
    }
  }
  await proveProjectEntry(identity.host, workspaceRoot, identity.canonicalRoot, source)
  const capability = identity.host.fileDeletion.capability
  return capability === 'unavailable'
    ? {
        outcome: 'unavailable',
        workspaceRoot,
        source,
        reason: 'Deletion is unavailable for this project host',
      }
    : {
        outcome: 'available',
        workspaceRoot,
        source,
        recovery: capability,
      }
}

export async function startProjectEntryDeletion(
  runtime: ProjectFileOperationRuntime,
  limits: ProjectFileCopyLimits,
  input: ProjectFileDeletionInput,
): Promise<ProjectFileOperationStartResult> {
  const identity = await runtime.prepare(input.owner, input.request.workspaceRoot)
  const admission = runtime.activate(identity, input.publish, 1)
  if (admission.outcome === 'busy') return admission
  const { operation } = admission
  runtime.launch(
    operation,
    async () => {
      runtime.publish(operation, {
        workspaceRoot: identity.workspaceRoot,
        operationId: identity.operationId,
        generation: identity.generation,
        phase: 'deleting',
        completedItems: 0,
        totalItems: 1,
      })
      const item = await deleteProjectEntry({
        host: identity.host,
        workspaceRoot: identity.workspaceRoot,
        canonicalRoot: identity.canonicalRoot,
        source: input.request.source,
        confirmedRecovery: input.request.confirmedRecovery,
        signal: operation.abort.signal,
        assertCurrent: () => runtime.assertCurrent(identity, operation.abort.signal),
        limits,
      })
      return {
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: [item],
      }
    },
    (reason) => ({
      outcome: 'completed',
      operationId: identity.operationId,
      generation: identity.generation,
      items: [
        {
          itemId: 'delete:0',
          source: input.request.source,
          destination: input.request.source,
          status: operation.abort.signal.aborted ? 'cancelled' : 'failed',
          effect: 'none',
          sourceDisposition: { outcome: 'retained', path: input.request.source },
          reason: boundedProjectFileReason(
            operation.abort.signal.reason ?? reason,
            'The deletion stopped unexpectedly',
          ),
        },
      ],
    }),
    () => undefined,
  )
  return {
    outcome: 'started',
    operationId: identity.operationId,
    generation: identity.generation,
    itemCount: 1,
  }
}
