import {
  basenameHostPath,
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  isProjectFileEntryName,
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOrganizationRequest,
} from '../../shared'
import {
  isProjectPathExistsError,
  type ProjectFileTransferPort,
  type ProjectHost,
} from '../project-host'
import {
  boundedProjectFileReason,
  proveProjectEntry,
  proveRealProjectDirectory,
  type ProvenProjectEntry,
} from './project-file-confinement'
import { isMissingProjectPathError } from './project-file-path-errors'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'
import { removeVerifiedProjectEntry } from './project-entry-removal'
import { caseOnlyProjectEntryRename } from './case-only-project-entry-rename'
import {
  projectEntryCancelled as cancelled,
  projectEntryConflict as conflict,
  projectEntryFailed as failed,
  projectEntrySkipped as skipped,
  retainedSource as retained,
  visibleSourceDisposition as visibleDisposition,
  projectEntryDestination,
} from './project-entry-operation-results'
import {
  copyVerifiedProjectEntry,
  projectHostCopySource,
  verifyProjectCopyReceipt,
} from './verified-project-copy'

export async function organizeProjectEntry(options: {
  readonly request: ProjectFileOrganizationRequest
  readonly host: ProjectHost
  readonly canonicalRoot: HostPath
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly limits: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly createTemporaryId?: () => string
  readonly acquireStaging?: () => { release(): void } | undefined
  readonly cleanupStaging: (host: ProjectHost, path: HostPath) => Promise<void>
}): Promise<ProjectFileItemResult> {
  const { request } = options
  const destinationDirectory =
    request.action === 'rename'
      ? dirnameHostPath(request.source)
      : request.destinationDirectory
  const name = request.action === 'move' ? basenameHostPath(request.source) : request.name
  const destination = projectEntryDestination(request)
  const sourceDisposition = retained(request.source)

  try {
    options.assertCurrent()
    if (hostPathEquals(request.source, request.workspaceRoot)) {
      return skipped(request.source, destination, 'The workspace root cannot be changed')
    }
    if (!isProjectFileEntryName(name)) {
      return failed(request.source, destination, 'The destination name is invalid')
    }

    const sourceEntry = await proveSource(options)
    const canonicalDestinationDirectory = await proveRealProjectDirectory(
      options.host,
      request.workspaceRoot,
      options.canonicalRoot,
      destinationDirectory,
    )
    const canonicalDestination = joinHostPath(canonicalDestinationDirectory, name)
    options.assertCurrent()

    if (hostPathEquals(sourceEntry.canonicalPath, canonicalDestination)) {
      return conflict(request.source, destination)
    }
    if (
      sourceEntry.type === 'dir' &&
      (request.action === 'move' || request.action === 'duplicate') &&
      containsHostPath(request.source, destinationDirectory)
    ) {
      return skipped(
        request.source,
        destination,
        request.action === 'move'
          ? 'A directory cannot move into itself or a descendant'
          : 'A directory cannot be duplicated into its own tree',
      )
    }
    if (request.action === 'duplicate') {
      return duplicateEntry(options, sourceEntry, {
        visibleDirectory: destinationDirectory,
        canonicalDirectory: canonicalDestinationDirectory,
        name,
      })
    }

    const caseOnly =
      request.action === 'rename' && isCaseOnlyPathChange(request.source, destination)
    if (caseOnly) {
      await reproveParents(
        options,
        sourceEntry,
        destination,
        canonicalDestinationDirectory,
      )
      options.assertCurrent()
      return caseOnlyProjectEntryRename({
        host: options.host,
        source: sourceEntry,
        visibleDestination: destination,
        canonicalDestination,
        signal: options.signal,
        assertCurrent: options.assertCurrent,
        createTemporaryId: options.createTemporaryId,
      })
    }
    if (await pathExists(options.host, canonicalDestination)) {
      return conflict(request.source, destination)
    }
    return atomicRenameOrMove(
      options,
      sourceEntry,
      destination,
      canonicalDestinationDirectory,
      canonicalDestination,
    )
  } catch (reason) {
    return {
      itemId: 'organize:0',
      source: request.source,
      destination,
      status: options.signal.aborted ? 'cancelled' : 'failed',
      effect: 'none',
      sourceDisposition,
      reason: boundedProjectFileReason(
        options.signal.reason ?? reason,
        'The project entry could not be changed',
      ),
    }
  }
}

async function proveSource(
  options: Parameters<typeof organizeProjectEntry>[0],
): Promise<ProvenProjectEntry> {
  return proveProjectEntry(
    options.host,
    options.request.workspaceRoot,
    options.canonicalRoot,
    options.request.source,
  )
}

async function duplicateEntry(
  options: Parameters<typeof organizeProjectEntry>[0],
  source: ProvenProjectEntry,
  destination: {
    readonly visibleDirectory: HostPath
    readonly canonicalDirectory: HostPath
    readonly name: string
  },
): Promise<ProjectFileItemResult> {
  const visibleDestination = joinHostPath(destination.visibleDirectory, destination.name)
  if (source.type === 'symlink') {
    return skipped(
      source.visiblePath,
      visibleDestination,
      'Symbolic links cannot be duplicated',
    )
  }
  const copied = await copyVerifiedProjectEntry({
    itemId: 'organize:0',
    name: destination.name,
    source: projectHostCopySource(options.host, source.canonicalPath),
    sourceType: source.type === 'dir' ? 'directory' : 'file',
    visibleDestinationDirectory: destination.visibleDirectory,
    canonicalDestinationDirectory: destination.canonicalDirectory,
    destinationHost: options.host,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    revalidateDestinationDirectory: () =>
      proveRealProjectDirectory(
        options.host,
        options.request.workspaceRoot,
        options.canonicalRoot,
        destination.visibleDirectory,
      ),
    limits: options.limits,
    createStagingId: options.createStagingId,
    cleanupStaging: options.cleanupStaging,
  })
  return {
    ...copied.result,
    source: source.visiblePath,
    sourceDisposition: retained(source.visiblePath),
    ...(copied.result.status === 'completed'
      ? {
          effect:
            source.type === 'dir'
              ? ('duplicated-directory' as const)
              : ('duplicated-file' as const),
        }
      : {}),
  }
}

async function atomicRenameOrMove(
  options: Parameters<typeof organizeProjectEntry>[0],
  source: ProvenProjectEntry,
  visibleDestination: HostPath,
  canonicalDestinationDirectory: HostPath,
  canonicalDestination: HostPath,
): Promise<ProjectFileItemResult> {
  const transfer = requireTransfer(options.host)
  options.assertCurrent()
  await reproveParents(options, source, visibleDestination, canonicalDestinationDirectory)
  options.assertCurrent()
  let submitted = false
  try {
    await transfer.renameNoReplace(source.canonicalPath, canonicalDestination, {
      signal: options.signal,
      onSubmitted: () => {
        submitted = true
      },
    })
    return completedMove(options, source.visiblePath, visibleDestination)
  } catch (reason) {
    if (options.signal.aborted && !submitted) {
      return cancelled(
        source.visiblePath,
        visibleDestination,
        boundedProjectFileReason(
          options.signal.reason ?? reason,
          'The operation was cancelled',
        ),
      )
    }
    if (isProjectPathExistsError(reason)) {
      return conflict(source.visiblePath, visibleDestination)
    }
    if (options.request.action !== 'move' || !isCrossDeviceError(reason)) {
      return failed(
        source.visiblePath,
        visibleDestination,
        boundedProjectFileReason(reason, 'The entry could not be renamed'),
      )
    }
    if (source.type === 'symlink') {
      return skipped(
        source.visiblePath,
        visibleDestination,
        'A symbolic link cannot move across filesystems',
      )
    }
    if (options.signal.aborted) {
      return failed(
        source.visiblePath,
        visibleDestination,
        boundedProjectFileReason(
          options.signal.reason,
          'The move was cancelled after atomic rename was attempted',
        ),
      )
    }
    const staging = options.acquireStaging?.()
    if (options.acquireStaging && !staging) {
      return failed(
        source.visiblePath,
        visibleDestination,
        'Pending staging cleanup has reached the host safety limit',
      )
    }
    try {
      return await crossDeviceMove(
        options,
        source,
        visibleDestination,
        canonicalDestinationDirectory,
        canonicalDestination,
      )
    } finally {
      staging?.release()
    }
  }
}

async function crossDeviceMove(
  options: Parameters<typeof organizeProjectEntry>[0],
  source: ProvenProjectEntry,
  visibleDestination: HostPath,
  canonicalDestinationDirectory: HostPath,
  canonicalDestination: HostPath,
): Promise<ProjectFileItemResult> {
  const copied = await copyVerifiedProjectEntry({
    itemId: 'organize:0',
    name: basenameHostPath(visibleDestination),
    source: projectHostCopySource(options.host, source.canonicalPath),
    sourceType: source.type === 'dir' ? 'directory' : 'file',
    visibleDestinationDirectory: dirnameHostPath(visibleDestination),
    canonicalDestinationDirectory,
    destinationHost: options.host,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    revalidateDestinationDirectory: () =>
      proveRealProjectDirectory(
        options.host,
        options.request.workspaceRoot,
        options.canonicalRoot,
        dirnameHostPath(visibleDestination),
      ),
    limits: options.limits,
    createStagingId: options.createStagingId,
    cleanupStaging: options.cleanupStaging,
  })
  const copiedResult = {
    ...copied.result,
    source: source.visiblePath,
    sourceDisposition: retained(source.visiblePath),
  }
  if (copied.result.status !== 'completed' || !copied.receipt) return copiedResult

  try {
    options.assertCurrent()
    const reproved = await proveSource(options)
    if (
      !hostPathEquals(reproved.canonicalPath, source.canonicalPath) ||
      reproved.type !== source.type
    ) {
      throw new Error('The source identity changed after destination publication')
    }
    await verifyProjectCopyReceipt({
      receipt: copied.receipt,
      source: projectHostCopySource(options.host, reproved.canonicalPath),
      destinationHost: options.host,
      destination: canonicalDestination,
      signal: options.signal,
    })
    const removal = await removeVerifiedProjectEntry({
      host: options.host,
      source: reproved.canonicalPath,
      receipt: copied.receipt,
      assertCommitAllowed: options.assertCurrent,
    })
    if (removal.disposition.outcome === 'removed') {
      return completedMove(options, source.visiblePath, visibleDestination)
    }
    return {
      ...copiedResult,
      status: 'failed',
      sourceDisposition: visibleDisposition(removal.disposition, source.visiblePath),
      reason: boundedProjectFileReason(
        removal.error,
        'The destination was copied, but the source could not be fully removed',
      ),
    }
  } catch (reason) {
    return {
      ...copiedResult,
      status: 'failed',
      reason: boundedProjectFileReason(
        options.signal.reason ?? reason,
        'The destination was copied, but the source was retained',
      ),
    }
  }
}

async function reproveParents(
  options: Parameters<typeof organizeProjectEntry>[0],
  source: ProvenProjectEntry,
  destination: HostPath,
  expectedDestinationParent: HostPath,
): Promise<void> {
  const [sourceParent, destinationParent] = await Promise.all([
    proveRealProjectDirectory(
      options.host,
      options.request.workspaceRoot,
      options.canonicalRoot,
      source.visibleParent,
    ),
    proveRealProjectDirectory(
      options.host,
      options.request.workspaceRoot,
      options.canonicalRoot,
      dirnameHostPath(destination),
    ),
  ])
  if (
    !hostPathEquals(sourceParent, source.canonicalParent) ||
    !hostPathEquals(destinationParent, expectedDestinationParent)
  ) {
    throw new Error('A source or destination parent changed during the operation')
  }
  const live = await options.host.stat(source.canonicalPath)
  if (live.type !== source.type) throw new Error('The source type changed')
}

function completedMove(
  options: Parameters<typeof organizeProjectEntry>[0],
  source: HostPath,
  destination: HostPath,
): ProjectFileItemResult {
  return {
    itemId: 'organize:0',
    source,
    destination,
    status: 'completed',
    effect: options.request.action === 'rename' ? 'renamed-entry' : 'moved-entry',
    sourceDisposition: { outcome: 'removed' },
  }
}

function requireTransfer(host: ProjectHost): ProjectFileTransferPort {
  if (!host.fileTransfer) {
    throw new Error('This project host cannot rename or stream project entries')
  }
  return host.fileTransfer
}

async function pathExists(host: ProjectHost, path: HostPath): Promise<boolean> {
  try {
    await host.stat(path)
    return true
  } catch (reason) {
    if (isMissingProjectPathError(reason)) return false
    throw reason
  }
}

function isCrossDeviceError(reason: unknown): boolean {
  const code = (reason as { readonly code?: unknown } | undefined)?.code
  const message = reason instanceof Error ? reason.message : ''
  return code === 'EXDEV' || code === 18 || /cross-device|\bEXDEV\b/i.test(message)
}

function isCaseOnlyPathChange(source: HostPath, destination: HostPath): boolean {
  const sourceParent = dirnameHostPath(source)
  const destinationParent = dirnameHostPath(destination)
  const sourceName = basenameHostPath(source)
  const destinationName = basenameHostPath(destination)
  return (
    hostPathEquals(sourceParent, destinationParent) &&
    sourceName !== destinationName &&
    sourceName.toLocaleLowerCase('en-US') === destinationName.toLocaleLowerCase('en-US')
  )
}
