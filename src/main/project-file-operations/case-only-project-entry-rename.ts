import { randomUUID } from 'node:crypto'

import {
  isProjectFileEntryName,
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
} from '../../shared'
import {
  isProjectPathExistsError,
  type ProjectFileTransferPort,
  type ProjectHost,
} from '../project-host'
import { boundedProjectFileReason } from './project-file-confinement'
import type { ProvenProjectEntry } from './project-entry-organization'
import { projectEntryCancelled } from './project-entry-operation-results'

/** Case-only rename is a two-leg transaction whose temporary path is user data. */
export async function caseOnlyProjectEntryRename(options: {
  readonly host: ProjectHost
  readonly source: ProvenProjectEntry
  readonly visibleDestination: HostPath
  readonly canonicalDestination: HostPath
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly createTemporaryId?: () => string
}): Promise<ProjectFileItemResult> {
  const transfer = requireTransfer(options.host)
  let temporary: { readonly visible: HostPath; readonly canonical: HostPath } | undefined
  for (let attempt = 0; attempt < 4 && !temporary; attempt += 1) {
    const name = `.hvir-rename-${options.createTemporaryId?.() ?? randomUUID()}`
    if (!isProjectFileEntryName(name)) continue
    const candidate = {
      visible: joinHostPath(options.source.visibleParent, name),
      canonical: joinHostPath(options.source.canonicalParent, name),
    }
    options.assertCurrent()
    let submitted = false
    try {
      await transfer.renameNoReplace(options.source.canonicalPath, candidate.canonical, {
        signal: options.signal,
        onSubmitted: () => {
          submitted = true
        },
      })
      // The temporary path now owns the only known source. Never register it
      // with prefix cleanup: rollback or the returned recovery path owns it.
      temporary = candidate
    } catch (reason) {
      if (options.signal.aborted && !submitted) {
        return projectEntryCancelled(
          options.source.visiblePath,
          options.visibleDestination,
          boundedProjectFileReason(
            options.signal.reason ?? reason,
            'The operation was cancelled',
          ),
        )
      }
      if (!isProjectPathExistsError(reason)) {
        return failed(
          options,
          options.source.visiblePath,
          boundedProjectFileReason(reason, 'The case-only rename could not begin'),
        )
      }
    }
  }
  if (!temporary) {
    return failed(
      options,
      options.source.visiblePath,
      'A collision-free temporary rename path could not be reserved',
    )
  }

  let publicationSubmitted = false
  try {
    options.assertCurrent()
    await transfer.renameNoReplace(temporary.canonical, options.canonicalDestination, {
      signal: options.signal,
      onSubmitted: () => {
        publicationSubmitted = true
      },
    })
    return {
      itemId: 'organize:0',
      source: options.source.visiblePath,
      destination: options.visibleDestination,
      status: 'completed',
      effect: 'renamed-entry',
      sourceDisposition: { outcome: 'removed' },
    }
  } catch (publicationError) {
    try {
      await transfer.renameNoReplace(temporary.canonical, options.source.canonicalPath)
      return {
        itemId: 'organize:0',
        source: options.source.visiblePath,
        destination: options.visibleDestination,
        status: options.signal.aborted && !publicationSubmitted ? 'cancelled' : 'failed',
        effect: 'none',
        sourceDisposition: {
          outcome: 'retained',
          path: options.source.visiblePath,
        },
        reason: boundedProjectFileReason(
          options.signal.reason ?? publicationError,
          'The requested casing could not be published; the original was restored',
        ),
      }
    } catch (restoreError) {
      return failed(
        options,
        temporary.visible,
        boundedProjectFileReason(
          restoreError,
          `The original could not be restored; the source remains at ${temporary.visible.path}`,
        ),
      )
    }
  }
}

function requireTransfer(host: ProjectHost): ProjectFileTransferPort {
  if (!host.fileTransfer) throw new Error('This project host cannot rename entries')
  return host.fileTransfer
}

function failed(
  options: Parameters<typeof caseOnlyProjectEntryRename>[0],
  recoveryPath: HostPath,
  reason: string,
): ProjectFileItemResult {
  return {
    itemId: 'organize:0',
    source: options.source.visiblePath,
    destination: options.visibleDestination,
    status: 'failed',
    effect: 'none',
    sourceDisposition: { outcome: 'retained', path: recoveryPath },
    reason,
  }
}
