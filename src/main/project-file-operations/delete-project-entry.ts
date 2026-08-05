import {
  dirnameHostPath,
  hostPathEquals,
  isProjectFileEntryName,
  joinHostPath,
  type FileType,
  type HostPath,
  type ProjectFileDeletionRecovery,
  type ProjectFileItemResult,
  type ProjectFileSourceDisposition,
  type Stat,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  boundedProjectFileReason,
  proveProjectEntry,
  proveRealProjectDirectory,
} from './project-file-confinement'
import { isMissingProjectPathError } from './project-file-path-errors'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'

interface DeletionPlanEntry {
  readonly path: HostPath
  readonly type: Exclude<FileType, 'other'>
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
  readonly children?: readonly string[]
}

interface DeletionPlan {
  readonly entries: readonly DeletionPlanEntry[]
}

export async function deleteProjectEntry(options: {
  readonly host: ProjectHost
  readonly workspaceRoot: HostPath
  readonly canonicalRoot: HostPath
  readonly source: HostPath
  readonly confirmedRecovery: ProjectFileDeletionRecovery
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly limits: ProjectFileCopyLimits
}): Promise<ProjectFileItemResult> {
  let committed = false
  let removedEntries = 0
  let totalEntries = 0
  let canonicalSource: HostPath | undefined
  let plannedSource: DeletionPlanEntry | undefined
  try {
    options.assertCurrent()
    if (hostPathEquals(options.source, options.workspaceRoot)) {
      return failed(options.source, 'The workspace root cannot be deleted')
    }
    const source = await proveProjectEntry(
      options.host,
      options.workspaceRoot,
      options.canonicalRoot,
      options.source,
    )
    canonicalSource = source.canonicalPath
    const capability = options.host.fileDeletion.capability
    if (capability === 'unavailable') {
      return failed(options.source, 'Deletion is unavailable for this project host')
    }
    if (capability !== options.confirmedRecovery) {
      return failed(
        options.source,
        'The project host deletion guarantee changed; review the operation again',
      )
    }
    const plan = await planDeletion(
      options.host,
      source.canonicalPath,
      options.signal,
      options.limits,
    )
    totalEntries = plan.entries.length
    plannedSource = plan.entries[0]
    await revalidateDeletionPlan(options.host, plan, options.signal)
    options.assertCurrent()

    if (capability === 'recoverable') {
      await options.host.fileDeletion.trashEntry(source.canonicalPath, {
        signal: options.signal,
        onSubmitted: () => {
          committed = true
        },
      })
      return completed(options.source, 'trashed-entry', totalEntries)
    }

    for (const entry of [...plan.entries].reverse()) {
      options.assertCurrent()
      await proveRealProjectDirectory(
        options.host,
        options.canonicalRoot,
        options.canonicalRoot,
        dirnameHostPath(entry.path),
      )
      options.assertCurrent()
      committed = true
      if (entry.type === 'dir') {
        const transfer = options.host.fileTransfer
        if (!transfer) throw new Error('This project host cannot remove directories')
        await transfer.removeDirectory(entry.path)
      } else {
        await options.host.removeFile(entry.path, { expectedMtimeMs: entry.mtimeMs })
      }
      removedEntries += 1
    }
    return completed(options.source, 'permanently-deleted-entry', totalEntries)
  } catch (reason) {
    if (
      committed &&
      options.confirmedRecovery === 'recoverable' &&
      canonicalSource &&
      plannedSource
    ) {
      return recoverableFailure(
        options.host,
        options.source,
        canonicalSource,
        plannedSource,
        totalEntries,
        reason,
      )
    }
    const cancelled = options.signal.aborted && !committed
    const disposition = deletionDisposition(options.source, removedEntries, totalEntries)
    return {
      itemId: 'delete:0',
      source: options.source,
      destination: options.source,
      status: cancelled ? 'cancelled' : 'failed',
      effect: removedEntries > 0 ? 'partially-deleted-entry' : 'none',
      sourceDisposition: disposition,
      reason: boundedProjectFileReason(
        cancelled ? options.signal.reason : reason,
        cancelled
          ? 'The deletion was cancelled before destructive execution'
          : 'The project entry could not be deleted',
      ),
    }
  }
}

async function recoverableFailure(
  host: ProjectHost,
  source: HostPath,
  canonicalSource: HostPath,
  plannedSource: DeletionPlanEntry,
  totalEntries: number,
  reason: unknown,
): Promise<ProjectFileItemResult> {
  try {
    if (sameEntry(plannedSource, await host.stat(canonicalSource))) {
      return failed(source, boundedProjectFileReason(reason, 'Trash rejected the entry'))
    }
  } catch (observationError) {
    if (!isMissingProjectPathError(observationError)) {
      return unknownFailure(source, totalEntries, reason)
    }
  }
  return unknownFailure(source, totalEntries, reason)
}

async function planDeletion(
  host: ProjectHost,
  root: HostPath,
  signal: AbortSignal,
  limits: ProjectFileCopyLimits,
): Promise<DeletionPlan> {
  const entries: DeletionPlanEntry[] = []
  const visit = async (path: HostPath, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (depth > limits.maxDepth) throw new Error('The entry exceeds the depth limit')
    if (entries.length >= limits.maxEntries) {
      throw new Error('The entry exceeds the entry limit')
    }
    const stat = await host.stat(path)
    if (!['file', 'dir', 'symlink'].includes(stat.type)) {
      throw new Error('The entry tree contains an unsupported filesystem object')
    }
    if (stat.type !== 'dir') {
      entries.push(observedEntry(path, stat))
      return
    }
    const children = [...(await host.readdir(path))].sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )
    if (children.some((entry) => !isProjectFileEntryName(entry.name))) {
      throw new Error('The entry tree contains an invalid entry name')
    }
    entries.push(
      observedEntry(
        path,
        stat,
        children.map((entry) => entry.name),
      ),
    )
    for (const child of children) await visit(joinHostPath(path, child.name), depth + 1)
  }
  await visit(root, 0)
  return { entries }
}

async function revalidateDeletionPlan(
  host: ProjectHost,
  plan: DeletionPlan,
  signal: AbortSignal,
): Promise<void> {
  for (const expected of plan.entries) {
    signal.throwIfAborted()
    const current = await host.stat(expected.path)
    if (!sameEntry(expected, current)) {
      throw new Error('The deletion target changed during confirmation')
    }
    if (expected.type !== 'dir') continue
    const children = (await host.readdir(expected.path))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (JSON.stringify(children) !== JSON.stringify(expected.children)) {
      throw new Error('The deletion target changed during confirmation')
    }
  }
}

function observedEntry(
  path: HostPath,
  stat: Stat,
  children?: readonly string[],
): DeletionPlanEntry {
  if (stat.type !== 'file' && stat.type !== 'dir' && stat.type !== 'symlink') {
    throw new Error('The entry tree contains an unsupported filesystem object')
  }
  return {
    path,
    type: stat.type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    ...(children ? { children } : {}),
  }
}

function sameEntry(expected: DeletionPlanEntry, current: Stat): boolean {
  return (
    current.type === expected.type &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.mode === expected.mode
  )
}

function completed(
  source: HostPath,
  effect: 'trashed-entry' | 'permanently-deleted-entry',
  totalEntries: number,
): ProjectFileItemResult {
  return {
    itemId: 'delete:0',
    source,
    destination: source,
    status: 'completed',
    effect,
    sourceDisposition: {
      outcome: 'removed',
      removedEntries: totalEntries,
      totalEntries,
    },
  }
}

function failed(source: HostPath, reason: string): ProjectFileItemResult {
  return {
    itemId: 'delete:0',
    source,
    destination: source,
    status: 'failed',
    effect: 'none',
    sourceDisposition: { outcome: 'retained', path: source },
    reason,
  }
}

function unknownFailure(
  source: HostPath,
  totalEntries: number,
  reason: unknown,
): ProjectFileItemResult {
  return {
    itemId: 'delete:0',
    source,
    destination: source,
    status: 'failed',
    effect: 'deletion-state-unknown',
    sourceDisposition: { outcome: 'unknown', path: source, totalEntries },
    reason: boundedProjectFileReason(reason, 'Trash outcome could not be verified'),
  }
}

function deletionDisposition(
  source: HostPath,
  removedEntries: number,
  totalEntries: number,
): ProjectFileSourceDisposition {
  return removedEntries === 0
    ? { outcome: 'retained', path: source, removedEntries, totalEntries }
    : {
        outcome: 'partially-removed',
        path: source,
        removedEntries,
        totalEntries,
      }
}
