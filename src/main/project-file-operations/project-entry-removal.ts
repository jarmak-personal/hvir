import { type HostPath, type ProjectFileSourceDisposition } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { VerifiedProjectCopyReceipt } from './verified-project-copy'
import { relativeHostPath } from './verified-project-copy-manifest'
import { normalizeVerifiedProjectEntryMetadata } from './verified-project-entry-metadata'

export interface ProjectEntryRemovalOutcome {
  readonly disposition: ProjectFileSourceDisposition
  readonly error?: unknown
}

/**
 * Remove one already reverified copied source bottom-up. The caller owns the
 * destructive commit check. Once the first immediate primitive starts, this
 * function runs to a truthful complete or partial disposition without
 * reinterpreting a later cancellation as no effect.
 */
export async function removeVerifiedProjectEntry(options: {
  readonly host: ProjectHost
  readonly source: HostPath
  readonly receipt: VerifiedProjectCopyReceipt
  readonly assertCommitAllowed: () => void
}): Promise<ProjectEntryRemovalOutcome> {
  const transfer = options.host.fileTransfer
  if (!transfer) {
    return {
      disposition: retained(options.source, 0, options.receipt.plan.entries.length),
      error: new Error('This project host cannot remove a copied directory tree'),
    }
  }

  let removedEntries = 0
  let committed = false
  try {
    const observations = new Map<string, Awaited<ReturnType<ProjectHost['stat']>>>()
    for (const entry of options.receipt.plan.entries) {
      const path = relativeHostPath(options.source, entry.relativePath)
      const current = await options.host.stat(path)
      if (!matchesVerifiedEntry(current, entry)) {
        throw new Error('The source changed after copy verification')
      }
      observations.set(entry.relativePath, current)
    }
    for (const entry of [...options.receipt.plan.entries].reverse()) {
      const path = relativeHostPath(options.source, entry.relativePath)
      const current = observations.get(entry.relativePath)!
      if (entry.type === 'directory') {
        if (!committed) {
          options.assertCommitAllowed()
          committed = true
        }
        await transfer.removeDirectory(path)
      } else {
        if (!committed) {
          options.assertCommitAllowed()
          committed = true
        }
        await options.host.removeFile(path, { expectedMtimeMs: current.mtimeMs })
      }
      removedEntries += 1
    }
    return {
      disposition: {
        outcome: 'removed',
        removedEntries,
        totalEntries: options.receipt.plan.entries.length,
      },
    }
  } catch (error) {
    return {
      disposition:
        removedEntries === 0
          ? retained(options.source, 0, options.receipt.plan.entries.length)
          : {
              outcome: 'partially-removed',
              path: options.source,
              removedEntries,
              totalEntries: options.receipt.plan.entries.length,
            },
      error,
    }
  }
}

function matchesVerifiedEntry(
  stat: Awaited<ReturnType<ProjectHost['stat']>>,
  expected: VerifiedProjectCopyReceipt['plan']['entries'][number],
): boolean {
  const normalized = normalizeVerifiedProjectEntryMetadata(stat)
  if (!normalized.ok) return false
  const current = normalized.value
  return (
    current.type === expected.type &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    current.mtimeSeconds === expected.mtimeSeconds
  )
}

function retained(
  path: HostPath,
  removedEntries: number,
  totalEntries: number,
): ProjectFileSourceDisposition {
  return { outcome: 'retained', path, removedEntries, totalEntries }
}
