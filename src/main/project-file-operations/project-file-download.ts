import { randomUUID } from 'node:crypto'
import {
  basenameHostPath,
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  isProjectFileEntryName,
  LOCAL_HOST_ID,
  type ProjectFileDownloadRequest,
  type ProjectFileDownloadStartResult,
  type ProjectFileOperationProgress,
  type ProjectFileItemResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { DownloadDirectoryPickerPort } from './electron-download-picker'
import { acquireDownloadDestination } from './download-destination-grant'
import { confinedProjectCopySource } from './confined-project-copy-source'
import {
  assertNormalizedAbsoluteProjectPath,
  boundedProjectFileReason,
  proveProjectEntry,
} from './project-file-confinement'
import type { ProjectFileOperationRuntime } from './project-file-operation-runtime'
import type { ProjectFileStagingCleanup } from './staging-cleanup'
import {
  copyVerifiedProjectEntry,
  type ProjectFileCopyLimits,
} from './verified-project-copy'

export async function startProjectFileDownload(options: {
  readonly runtime: ProjectFileOperationRuntime
  readonly stagingCleanup: ProjectFileStagingCleanup
  readonly localHost: ProjectHost
  readonly picker: DownloadDirectoryPickerPort
  readonly limits: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly input: ProjectFileDownloadRequest & {
    readonly owner: RendererOwner
    readonly publish: (progress: ProjectFileOperationProgress) => void
  }
}): Promise<ProjectFileDownloadStartResult> {
  const { input, runtime } = options
  assertNormalizedAbsoluteProjectPath(input.workspaceRoot)
  assertNormalizedAbsoluteProjectPath(input.source)
  if (
    input.workspaceRoot.hostId === LOCAL_HOST_ID ||
    !containsHostPath(input.workspaceRoot, input.source) ||
    hostPathEquals(input.workspaceRoot, input.source)
  )
    throw new Error('Download requires an entry inside a registered SSH workspace')
  if (!isProjectFileEntryName(basenameHostPath(input.source))) {
    throw new Error('The source name is unsupported for file transfers')
  }
  const identity = await runtime.prepare(input.owner, input.workspaceRoot)
  const admission = runtime.activate(identity, input.publish, 1)
  if (admission.outcome === 'busy') return admission
  const { operation } = admission
  const assertCurrent = () => runtime.assertCurrent(identity, operation.abort.signal)
  let launched = false
  let grant: Awaited<ReturnType<typeof acquireDownloadDestination>> | undefined
  let staging: ReturnType<ProjectFileStagingCleanup['reserve']>
  try {
    const source = await proveProjectEntry(
      identity.host,
      identity.workspaceRoot,
      identity.canonicalRoot,
      input.source,
    )
    assertCurrent()
    if (source.type !== 'file' && source.type !== 'dir') {
      throw new Error('Only regular files and folders can be downloaded')
    }
    const selectedPath = await options.picker.pick()
    assertCurrent()
    if (selectedPath === undefined) return { outcome: 'cancelled' }
    const stagingId = options.createStagingId?.() ?? randomUUID()
    grant = await acquireDownloadDestination({
      host: options.localHost,
      selectedPath,
      name: basenameHostPath(input.source),
      stagingId,
      assertOperationCurrent: assertCurrent,
    })
    staging = options.stagingCleanup.reserve(options.localHost, 1, grant.proveCleanupPath)
    if (!staging)
      return {
        outcome: 'busy',
        reason: 'Pending local staging cleanup has reached the safety limit',
      }
    const destination = grant
    const reservation = staging
    const visibleDestination = joinHostPath(
      destination.directory,
      basenameHostPath(input.source),
    )
    const failure = (reason: unknown): ProjectFileItemResult => ({
      itemId: 'download:0',
      source: input.source,
      destination: visibleDestination,
      sourceDisposition: { outcome: 'retained', path: input.source },
      status: operation.abort.signal.aborted ? 'cancelled' : 'failed',
      effect: 'none',
      reason: boundedProjectFileReason(reason, 'The download could not complete'),
    })
    runtime.launch(
      operation,
      async () => {
        runtime.publish(operation, {
          workspaceRoot: identity.workspaceRoot,
          operationId: identity.operationId,
          generation: identity.generation,
          phase: 'downloading',
          completedItems: 0,
          totalItems: 1,
          currentName: basenameHostPath(input.source),
        })
        await destination.revalidate()
        const copied = await copyVerifiedProjectEntry({
          itemId: 'download:0',
          name: basenameHostPath(input.source),
          source: confinedProjectCopySource({
            host: identity.host,
            workspaceRoot: identity.canonicalRoot,
            root: source.canonicalPath,
            assertCurrent: destination.assertCurrent,
          }),
          sourceType: source.type === 'dir' ? 'directory' : 'file',
          visibleDestinationDirectory: destination.directory,
          canonicalDestinationDirectory: destination.directory,
          destinationHost: destination.destination,
          signal: operation.abort.signal,
          assertCurrent: destination.assertCurrent,
          revalidateDestinationDirectory: destination.revalidate,
          limits: options.limits,
          createStagingId: () => stagingId,
          cleanupStaging: (path) => reservation.cleanup(path),
        })
        return {
          outcome: 'completed',
          operationId: identity.operationId,
          generation: identity.generation,
          items: [
            {
              ...copied.result,
              source: input.source,
              sourceDisposition: { outcome: 'retained', path: input.source },
            },
          ],
        }
      },
      (reason) => ({
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: [failure(operation.abort.signal.reason ?? reason)],
      }),
      () => {
        destination.revoke()
        reservation.release()
      },
    )
    launched = true
    return {
      outcome: 'started',
      operationId: identity.operationId,
      generation: identity.generation,
      itemCount: 1,
    }
  } finally {
    if (!launched) {
      grant?.revoke()
      staging?.release()
      await runtime.release(operation)
    }
  }
}
