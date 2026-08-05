import {
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOperationResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type {
  ExternalFileCopyGrantUse,
  GrantedExternalFileItem,
} from './external-file-grants'
import {
  copyVerifiedProjectEntry,
  PROJECT_FILE_COPY_LIMITS,
  type ProjectFileCopyLimits,
} from './verified-project-copy'

/** Thin external-grant batch adapter over the reusable verified-copy pipeline. */
export async function copyExternalFileGrant(options: {
  readonly operationId: string
  readonly generation: number
  readonly visibleDestinationDirectory: HostPath
  readonly canonicalDestinationDirectory: HostPath
  readonly destinationHost: ProjectHost
  readonly grant: ExternalFileCopyGrantUse
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly revalidateDestinationDirectory: () => Promise<HostPath>
  readonly limits?: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly cleanupStaging: (host: ProjectHost, path: HostPath) => Promise<void>
  readonly onProgress: (
    completedItems: number,
    totalItems: number,
    currentName?: string,
  ) => void
}): Promise<ProjectFileOperationResult> {
  const limits = options.limits ?? PROJECT_FILE_COPY_LIMITS
  const results: ProjectFileItemResult[] = []
  let acceptedEntries = 0
  let acceptedBytes = 0
  for (const item of options.grant.items) {
    options.onProgress(results.length, options.grant.items.length, item.name)
    if (options.signal.aborted) {
      results.push(cancelledItem(options, item))
      continue
    }
    const destination = joinHostPath(options.visibleDestinationDirectory, item.name)
    if (item.type === 'unsupported' || !item.source || !item.initialStat) {
      results.push({
        itemId: item.itemId,
        destination,
        status: 'skipped',
        effect: 'none',
        reason: boundedReason(item.reason, 'This source is unsupported'),
      })
      continue
    }
    try {
      const sourcePort = options.grant.source(item.itemId)
      const outcome = await copyVerifiedProjectEntry({
        itemId: item.itemId,
        name: item.name,
        sourceType: item.type,
        source: {
          root: item.source,
          stat: (path) => sourcePort.stat(path),
          readdir: (path) => sourcePort.readdir(path),
          readFileChunks: (path, signal) => sourcePort.readFileChunks(path, signal),
        },
        visibleDestinationDirectory: options.visibleDestinationDirectory,
        canonicalDestinationDirectory: options.canonicalDestinationDirectory,
        destinationHost: options.destinationHost,
        signal: options.signal,
        assertCurrent: options.assertCurrent,
        revalidateDestinationDirectory: options.revalidateDestinationDirectory,
        limits: {
          ...limits,
          maxEntries: Math.max(0, limits.maxEntries - acceptedEntries),
          maxTotalBytes: Math.max(0, limits.maxTotalBytes - acceptedBytes),
        },
        createStagingId: options.createStagingId,
        cleanupStaging: options.cleanupStaging,
      })
      acceptedEntries += outcome.entryCount
      acceptedBytes += outcome.totalBytes
      results.push(outcome.result)
    } catch (reason) {
      results.push({
        itemId: item.itemId,
        destination,
        status: options.signal.aborted ? 'cancelled' : 'failed',
        effect: 'none',
        reason: boundedReason(reason, 'This source could not be copied'),
      })
    }
  }
  options.onProgress(results.length, options.grant.items.length)
  return {
    outcome: 'completed',
    operationId: options.operationId,
    generation: options.generation,
    items: results,
  }
}

function cancelledItem(
  options: Parameters<typeof copyExternalFileGrant>[0],
  item: GrantedExternalFileItem,
): ProjectFileItemResult {
  return {
    itemId: item.itemId,
    destination: joinHostPath(options.visibleDestinationDirectory, item.name),
    status: 'cancelled',
    effect: 'none',
    reason: boundedReason(options.signal.reason, 'The operation was cancelled'),
  }
}

function boundedReason(reason: unknown, fallback: string): string {
  return (
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : fallback
  ).slice(0, 240)
}
