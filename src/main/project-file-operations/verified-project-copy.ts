import { createHash, randomUUID } from 'node:crypto'

import {
  hostPathEquals,
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
} from '../../shared'
import {
  isProjectPathExistsError,
  ProjectPathExistsError,
  type ProjectFileTransferPort,
  type ProjectHost,
} from '../project-host'
import {
  PROJECT_FILE_COPY_LIMITS,
  type ProjectFileCopyLimits,
} from './project-file-copy-limits'
import {
  manifestTree,
  manifestsEqual,
  preflight,
  relativeHostPath,
  UnsupportedSourceError,
  type ManifestRow,
  type PlannedTree,
  type TreeReadPort,
} from './verified-project-copy-manifest'

export { PROJECT_FILE_COPY_LIMITS, type ProjectFileCopyLimits }
export interface VerifiedProjectCopySource extends TreeReadPort {
  readonly root: HostPath
}

export interface VerifiedProjectCopyOutcome {
  readonly result: ProjectFileItemResult
  readonly entryCount: number
  readonly totalBytes: number
}

export async function copyVerifiedProjectEntry(options: {
  readonly itemId: string
  readonly name: string
  readonly source: VerifiedProjectCopySource
  readonly sourceType: 'file' | 'directory'
  readonly visibleDestinationDirectory: HostPath
  readonly canonicalDestinationDirectory: HostPath
  readonly destinationHost: ProjectHost
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly revalidateDestinationDirectory: () => Promise<HostPath>
  readonly limits?: ProjectFileCopyLimits
  readonly createStagingId?: () => string
  readonly cleanupStaging: (host: ProjectHost, path: HostPath) => Promise<void>
}): Promise<VerifiedProjectCopyOutcome> {
  const limits = options.limits ?? PROJECT_FILE_COPY_LIMITS
  const destination = joinHostPath(options.visibleDestinationDirectory, options.name)
  if (options.signal.aborted) {
    return { result: cancelledItem(options), entryCount: 0, totalBytes: 0 }
  }
  try {
    options.assertCurrent()
    const canonicalDestination = joinHostPath(
      options.canonicalDestinationDirectory,
      options.name,
    )
    if (await pathExists(options.destinationHost, canonicalDestination)) {
      return {
        result: conflict(options.itemId, destination),
        entryCount: 0,
        totalBytes: 0,
      }
    }
    const plan = await preflight(
      options.source,
      options.source.root,
      options.signal,
      limits,
    )
    if (plan.entries[0]?.type !== options.sourceType) {
      throw new UnsupportedSourceError(
        'The top-level source type changed after acquisition',
      )
    }
    return {
      result: await copyOne(options, plan),
      entryCount: plan.entries.length,
      totalBytes: plan.totalBytes,
    }
  } catch (reason) {
    return {
      result:
        options.signal.aborted || isAbortError(reason)
          ? cancelledItem(options)
          : {
              itemId: options.itemId,
              destination,
              status: reason instanceof UnsupportedSourceError ? 'skipped' : 'failed',
              effect: 'none',
              reason: boundedReason(reason, 'The source could not be inspected'),
            },
      entryCount: 0,
      totalBytes: 0,
    }
  }
}

async function copyOne(
  options: Parameters<typeof copyVerifiedProjectEntry>[0],
  plan: PlannedTree,
): Promise<ProjectFileItemResult> {
  const destination = joinHostPath(options.visibleDestinationDirectory, options.name)
  const canonicalDestination = joinHostPath(
    options.canonicalDestinationDirectory,
    options.name,
  )
  const staging = joinHostPath(
    options.canonicalDestinationDirectory,
    `.hvir-import-${options.createStagingId?.() ?? randomUUID()}`,
  )
  let stagingCreated = false
  try {
    options.assertCurrent()
    if (await pathExists(options.destinationHost, canonicalDestination)) {
      throw new ProjectPathExistsError()
    }
    const expected = await stageTree(
      options,
      options.source,
      options.source.root,
      staging,
      plan,
      () => {
        stagingCreated = true
      },
    )
    options.assertCurrent()
    const sourceManifest = await manifestTree(
      options.source,
      options.source.root,
      options.signal,
      plan,
    )
    const destinationManifest = await manifestTree(
      destinationReadPort(options.destinationHost),
      staging,
      options.signal,
      plan,
    )
    if (
      !manifestsEqual(expected, sourceManifest) ||
      !manifestsEqual(expected, destinationManifest)
    ) {
      throw new Error('The complete staged entry did not match its source')
    }
    options.assertCurrent()
    const revalidatedDestinationDirectory = await options.revalidateDestinationDirectory()
    options.assertCurrent()
    if (
      !hostPathEquals(
        revalidatedDestinationDirectory,
        options.canonicalDestinationDirectory,
      )
    ) {
      throw new Error('The destination directory changed during transfer')
    }
    if (await pathExists(options.destinationHost, canonicalDestination)) {
      throw new ProjectPathExistsError()
    }
    options.assertCurrent()
    await requireTransfer(options.destinationHost).renameNoReplace(
      staging,
      canonicalDestination,
      { signal: options.signal },
    )
    stagingCreated = false
    return {
      itemId: options.itemId,
      destination,
      status: 'completed',
      effect: options.sourceType === 'directory' ? 'copied-directory' : 'copied-file',
    }
  } catch (reason) {
    if (stagingCreated) {
      await options
        .cleanupStaging(options.destinationHost, staging)
        .catch(() => undefined)
    }
    if (isProjectPathExistsError(reason)) return conflict(options.itemId, destination)
    if (options.signal.aborted || isAbortError(reason)) {
      return cancelledItem(options)
    }
    return {
      itemId: options.itemId,
      destination,
      status: reason instanceof UnsupportedSourceError ? 'skipped' : 'failed',
      effect: 'none',
      reason: boundedReason(reason, 'The source could not be copied'),
    }
  }
}

async function stageTree(
  options: Parameters<typeof copyVerifiedProjectEntry>[0],
  sourceTransfer: TreeReadPort,
  sourceRoot: HostPath,
  stagingRoot: HostPath,
  plan: PlannedTree,
  created: () => void,
): Promise<readonly ManifestRow[]> {
  const destinationTransfer = requireTransfer(options.destinationHost)
  const rows: ManifestRow[] = []
  const root = plan.entries[0]!
  if (root.type === 'directory') {
    await options.destinationHost.createDirectoryExclusive(stagingRoot, {
      mode: 0o755,
      signal: options.signal,
      onCreated: created,
    })
  }
  for (const entry of plan.entries) {
    options.assertCurrent()
    const source = relativeHostPath(sourceRoot, entry.relativePath)
    const destination = relativeHostPath(stagingRoot, entry.relativePath)
    if (entry.type === 'directory') {
      if (entry.relativePath) {
        await options.destinationHost.createDirectoryExclusive(destination, {
          mode: 0o755,
          signal: options.signal,
        })
      }
      rows.push(entry)
      continue
    }
    let streamedBytes = 0
    const hash = createHash('sha256')
    const chunks = (async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of sourceTransfer.readFileChunks(source, options.signal)) {
        streamedBytes += chunk.byteLength
        if (streamedBytes > entry.size) {
          throw new UnsupportedSourceError('The source file grew during transfer')
        }
        hash.update(chunk)
        yield chunk
      }
      if (streamedBytes !== entry.size) {
        throw new UnsupportedSourceError('The source file changed during transfer')
      }
    })()
    await destinationTransfer.writeFileChunksExclusive(destination, chunks, {
      mode: entry.mode,
      signal: options.signal,
      ...(root.type === 'file' ? { onCreated: created } : {}),
    })
    await destinationTransfer.setMetadata(destination, {
      mode: entry.mode,
      mtimeSeconds: entry.mtimeSeconds,
      signal: options.signal,
    })
    rows.push({ ...entry, sha256: hash.digest('hex') })
  }
  for (const entry of [...plan.entries].reverse()) {
    if (entry.type !== 'directory') continue
    await destinationTransfer.setMetadata(
      relativeHostPath(stagingRoot, entry.relativePath),
      {
        mode: 0o755,
        mtimeSeconds: entry.mtimeSeconds,
        signal: options.signal,
      },
    )
  }
  return rows
}

function requireTransfer(host: ProjectHost): ProjectFileTransferPort {
  if (!host.fileTransfer)
    throw new Error('This project host cannot stream file transfers')
  return host.fileTransfer
}

function destinationReadPort(host: ProjectHost): TreeReadPort {
  const transfer = requireTransfer(host)
  return {
    stat: (path) => host.stat(path),
    readdir: (path) => host.readdir(path),
    readFileChunks: (path, signal) => transfer.readFileChunks(path, { signal }),
  }
}

async function pathExists(host: ProjectHost, path: HostPath): Promise<boolean> {
  try {
    await host.stat(path)
    return true
  } catch (reason) {
    if (isMissingPathError(reason)) return false
    throw reason
  }
}

function conflict(itemId: string, destination: HostPath): ProjectFileItemResult {
  return {
    itemId,
    destination,
    status: 'conflicted',
    effect: 'none',
    reason: 'The destination already exists',
  }
}

function cancelledItem(
  options: Parameters<typeof copyVerifiedProjectEntry>[0],
): ProjectFileItemResult {
  return {
    itemId: options.itemId,
    destination: joinHostPath(options.visibleDestinationDirectory, options.name),
    status: 'cancelled',
    effect: 'none',
    reason: boundedReason(options.signal.reason, 'The operation was cancelled'),
  }
}

function isMissingPathError(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return (
    code === 'ENOENT' ||
    code === 2 ||
    /no such file|not found/i.test(reason instanceof Error ? reason.message : '')
  )
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError'
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
