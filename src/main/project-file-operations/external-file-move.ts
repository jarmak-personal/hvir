import {
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOperationResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type {
  ExternalFileGrantSourcePort,
  ExternalFileMoveGrantUse,
  GrantedExternalFileItem,
} from './external-file-grants'
import {
  copyVerifiedProjectEntry,
  PROJECT_FILE_COPY_LIMITS,
  verifyProjectCopyReceipt,
  verifyProjectCopySourceReceipt,
  type ProjectFileCopyLimits,
  type VerifiedProjectCopyOutcome,
  type VerifiedProjectCopySource,
} from './verified-project-copy'

/** Verified publication followed by exact, recoverable external-source removal. */
export async function moveExternalFileGrant(options: {
  readonly operationId: string
  readonly generation: number
  readonly visibleDestinationDirectory: HostPath
  readonly canonicalDestinationDirectory: HostPath
  readonly destinationHost: ProjectHost
  readonly grant: ExternalFileMoveGrantUse
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
    const visibleDestination = joinHostPath(
      options.visibleDestinationDirectory,
      item.name,
    )
    if (item.type === 'unsupported' || !item.source || !item.initialStat) {
      results.push({
        itemId: item.itemId,
        destination: visibleDestination,
        status: 'skipped',
        effect: 'none',
        reason: boundedReason(item.reason, 'This source is unsupported'),
      })
      continue
    }
    try {
      const supportedItem = {
        ...item,
        source: item.source,
        initialStat: item.initialStat,
        type: item.type,
      }
      const sourcePort = options.grant.source(item.itemId)
      const source = externalSource(item.source, sourcePort)
      const copied = await copyVerifiedProjectEntry({
        itemId: item.itemId,
        name: item.name,
        sourceType: item.type,
        source,
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
      acceptedEntries += copied.entryCount
      acceptedBytes += copied.totalBytes
      results.push(
        copied.result.status === 'completed' && copied.receipt
          ? await finishMove(options, supportedItem, source, copied, copied.receipt)
          : sourceRetained(copied.result, item.source),
      )
    } catch (reason) {
      results.push({
        itemId: item.itemId,
        source: item.source,
        destination: visibleDestination,
        status: options.signal.aborted ? 'cancelled' : 'failed',
        effect: 'none',
        sourceDisposition: { outcome: 'retained', path: item.source },
        reason: boundedReason(reason, 'This source could not be moved'),
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

async function finishMove(
  options: Parameters<typeof moveExternalFileGrant>[0],
  item: GrantedExternalFileItem & {
    readonly source: HostPath
    readonly type: 'file' | 'directory'
  },
  source: VerifiedProjectCopySource,
  copied: VerifiedProjectCopyOutcome,
  receipt: NonNullable<VerifiedProjectCopyOutcome['receipt']>,
): Promise<ProjectFileItemResult> {
  const destination = joinHostPath(options.canonicalDestinationDirectory, item.name)
  try {
    options.assertCurrent()
    await verifyProjectCopyReceipt({
      receipt,
      source,
      destinationHost: options.destinationHost,
      destination,
      signal: options.signal,
    })
    options.assertCurrent()
  } catch (reason) {
    return sourceRetained(
      copied.result,
      item.source,
      boundedReason(reason, 'The published copy or source changed before Trash'),
    )
  }

  let submitted = false
  try {
    const observation = await options.grant.trashSource(item.itemId, {
      signal: options.signal,
      onSubmitted: () => {
        submitted = true
      },
      confirmExpectedSource: async () => {
        try {
          await verifyProjectCopySourceReceipt({
            receipt,
            source,
            signal: options.signal,
          })
          return true
        } catch {
          return false
        }
      },
    })
    if (observation === 'removed') {
      return {
        ...copied.result,
        source: item.source,
        effect:
          item.type === 'directory' ? 'moved-external-directory' : 'moved-external-file',
        sourceDisposition: { outcome: 'removed' },
      }
    }
    if (observation === 'retained') {
      return sourceRetained(
        copied.result,
        item.source,
        'The submitted Trash request failed; the verified copy and source both remain',
      )
    }
    return sourceUnknown(
      copied.result,
      item.source,
      'The Trash request was submitted, but the exact source outcome could not be verified',
    )
  } catch (reason) {
    return submitted
      ? sourceUnknown(
          copied.result,
          item.source,
          boundedReason(reason, 'The submitted Trash request did not settle truthfully'),
        )
      : sourceRetained(
          copied.result,
          item.source,
          boundedReason(reason, 'The source was retained before Trash submission'),
        )
  }
}

function externalSource(
  root: HostPath,
  source: ExternalFileGrantSourcePort,
): VerifiedProjectCopySource {
  return {
    root,
    stat: (path) => source.stat(path),
    readdir: (path) => source.readdir(path),
    readFileChunks: (path, signal) => source.readFileChunks(path, signal),
  }
}

function sourceRetained(
  result: ProjectFileItemResult,
  source: HostPath,
  reason?: string,
): ProjectFileItemResult {
  return {
    ...result,
    source,
    sourceDisposition: { outcome: 'retained', path: source },
    ...(reason ? { reason } : {}),
  }
}

function sourceUnknown(
  result: ProjectFileItemResult,
  source: HostPath,
  reason: string,
): ProjectFileItemResult {
  return {
    ...result,
    source,
    sourceDisposition: { outcome: 'unknown', path: source },
    reason,
  }
}

function cancelledItem(
  options: Parameters<typeof moveExternalFileGrant>[0],
  item: GrantedExternalFileItem,
): ProjectFileItemResult {
  return {
    itemId: item.itemId,
    ...(item.source
      ? {
          source: item.source,
          sourceDisposition: { outcome: 'retained' as const, path: item.source },
        }
      : {}),
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
