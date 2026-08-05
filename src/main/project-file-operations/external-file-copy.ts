import {
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOperationResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type {
  ExternalFileGrantUse,
  GrantedExternalFileItem,
} from './external-file-grants'
import {
  copyVerifiedProjectEntry,
  PROJECT_FILE_COPY_LIMITS,
  type ProjectFileCopyLimits,
  type VerifiedProjectCopyOutcome,
  type VerifiedProjectCopySource,
} from './verified-project-copy'

export interface ExternalFileGrantCopyOptions {
  readonly operationId: string
  readonly generation: number
  readonly visibleDestinationDirectory: HostPath
  readonly canonicalDestinationDirectory: HostPath
  readonly destinationHost: ProjectHost
  readonly grant: ExternalFileGrantUse
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
}

export interface ExternalFileCopiedItem {
  readonly item: GrantedExternalFileItem & {
    readonly source: HostPath
    readonly type: 'file' | 'directory'
  }
  readonly source: VerifiedProjectCopySource
  readonly copied: VerifiedProjectCopyOutcome
}

interface ExternalFileBatchItem {
  readonly item: GrantedExternalFileItem
  readonly destination: HostPath
  readonly reason: unknown
}

/** Stable bounded batch/copy owner shared by external copy and verified move. */
export async function copyExternalFileGrant(
  options: ExternalFileGrantCopyOptions & {
    readonly completeItem?: (
      copied: ExternalFileCopiedItem,
    ) => Promise<ProjectFileItemResult>
    readonly cancelledItem?: (
      item: Omit<ExternalFileBatchItem, 'reason'> & { readonly reason: unknown },
    ) => ProjectFileItemResult
    readonly failedItem?: (
      item: ExternalFileBatchItem & { readonly aborted: boolean },
    ) => ProjectFileItemResult
  },
): Promise<ProjectFileOperationResult> {
  const limits = options.limits ?? PROJECT_FILE_COPY_LIMITS
  const results: ProjectFileItemResult[] = []
  let acceptedEntries = 0
  let acceptedBytes = 0
  for (const item of options.grant.items) {
    options.onProgress(results.length, options.grant.items.length, item.name)
    const destination = joinHostPath(options.visibleDestinationDirectory, item.name)
    if (options.signal.aborted) {
      const cancelled = {
        item,
        destination,
        reason: options.signal.reason as unknown,
      }
      results.push(options.cancelledItem?.(cancelled) ?? defaultCancelledItem(cancelled))
      continue
    }
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
      const supportedItem = {
        ...item,
        source: item.source,
        initialStat: item.initialStat,
        type: item.type,
      }
      const sourcePort = options.grant.source(item.itemId)
      const source: VerifiedProjectCopySource = {
        root: item.source,
        stat: (path) => sourcePort.stat(path),
        readdir: (path) => sourcePort.readdir(path),
        readFileChunks: (path, signal) => sourcePort.readFileChunks(path, signal),
      }
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
        options.completeItem
          ? await options.completeItem({ item: supportedItem, source, copied })
          : copied.result,
      )
    } catch (reason) {
      const failed = { item, destination, reason, aborted: options.signal.aborted }
      results.push(options.failedItem?.(failed) ?? defaultFailedItem(failed))
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

function defaultCancelledItem(
  item: Omit<ExternalFileBatchItem, 'reason'> & { readonly reason: unknown },
): ProjectFileItemResult {
  return {
    itemId: item.item.itemId,
    destination: item.destination,
    status: 'cancelled',
    effect: 'none',
    reason: boundedReason(item.reason, 'The operation was cancelled'),
  }
}

function defaultFailedItem(
  item: ExternalFileBatchItem & { readonly aborted: boolean },
): ProjectFileItemResult {
  return {
    itemId: item.item.itemId,
    destination: item.destination,
    status: item.aborted ? 'cancelled' : 'failed',
    effect: 'none',
    reason: boundedReason(item.reason, 'This source could not be copied'),
  }
}

export function boundedExternalFileReason(reason: unknown, fallback: string): string {
  return boundedReason(reason, fallback)
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
