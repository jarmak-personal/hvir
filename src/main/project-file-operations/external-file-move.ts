import { joinHostPath, type HostPath, type ProjectFileItemResult } from '../../shared'
import type { ExternalFileMoveGrantUse } from './external-file-grants'
import {
  boundedExternalFileReason,
  copyExternalFileGrant,
  type ExternalFileCopiedItem,
  type ExternalFileGrantCopyOptions,
} from './external-file-copy'
import {
  verifyProjectCopyReceipt,
  verifyProjectCopySourceReceipt,
} from './verified-project-copy'

/** Verified publication followed by exact, recoverable external-source removal. */
export function moveExternalFileGrant(
  options: Omit<ExternalFileGrantCopyOptions, 'grant'> & {
    readonly grant: ExternalFileMoveGrantUse
  },
): Promise<import('../../shared').ProjectFileOperationResult> {
  return copyExternalFileGrant({
    ...options,
    completeItem: (copied) => finishMove(options, copied),
    cancelledItem: ({ item, destination, reason }) => ({
      itemId: item.itemId,
      destination,
      status: 'cancelled',
      effect: 'none',
      ...(item.source ? { sourceDisposition: { outcome: 'retained' as const } } : {}),
      reason: boundedExternalMoveReason(
        reason,
        'The operation was cancelled',
        item.source,
      ),
    }),
    failedItem: ({ item, destination, reason, aborted }) => ({
      itemId: item.itemId,
      destination,
      status: aborted ? 'cancelled' : 'failed',
      effect: 'none',
      ...(item.source ? { sourceDisposition: { outcome: 'retained' as const } } : {}),
      reason: boundedExternalMoveReason(
        reason,
        'This source could not be moved',
        item.source,
      ),
    }),
  })
}

async function finishMove(
  options: Parameters<typeof moveExternalFileGrant>[0],
  copiedItem: ExternalFileCopiedItem,
): Promise<ProjectFileItemResult> {
  const { item, source, copied } = copiedItem
  if (copied.result.status !== 'completed' || !copied.receipt) {
    return moveResult(copied.result, item.source, 'retained')
  }
  const receipt = copied.receipt
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
    return moveResult(
      copied.result,
      item.source,
      'retained',
      undefined,
      boundedExternalMoveReason(
        reason,
        'The published copy or source changed before Trash',
        item.source,
      ),
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
      return moveResult(
        copied.result,
        item.source,
        'removed',
        item.type === 'directory' ? 'moved-external-directory' : 'moved-external-file',
      )
    }
    if (observation === 'retained') {
      return moveResult(
        copied.result,
        item.source,
        'retained',
        undefined,
        'The submitted Trash request failed; the verified copy and source both remain',
      )
    }
    return moveResult(
      copied.result,
      item.source,
      'unknown',
      undefined,
      'The Trash request was submitted, but the exact source outcome could not be verified',
    )
  } catch (reason) {
    return moveResult(
      copied.result,
      item.source,
      submitted ? 'unknown' : 'retained',
      undefined,
      boundedExternalMoveReason(
        reason,
        submitted
          ? 'The submitted Trash request did not settle truthfully'
          : 'The source was retained before Trash submission',
        item.source,
      ),
    )
  }
}

function moveResult(
  result: ProjectFileItemResult,
  source: HostPath,
  sourceOutcome: 'retained' | 'removed' | 'unknown',
  effect = result.effect,
  reason = result.reason,
): ProjectFileItemResult {
  const safeReason = reason
    ? boundedExternalMoveReason(reason, 'The external move did not settle', source)
    : undefined
  return {
    itemId: result.itemId,
    destination: result.destination,
    status: result.status,
    effect,
    sourceDisposition: { outcome: sourceOutcome },
    ...(safeReason ? { reason: safeReason } : {}),
  }
}

export function boundedExternalMoveReason(
  reason: unknown,
  fallback: string,
  source?: HostPath,
): string {
  const bounded = boundedExternalFileReason(reason, fallback)
  return source ? bounded.split(source.path).join('[external source]') : bounded
}
