import { hostPathEquals, joinHostPath, type HostPath } from '../../shared/host-path'
import {
  SKILLAGER_REVIEW_FILE_BYTES,
  SKILLAGER_REVIEW_MAX_BYTES,
  SKILLAGER_REVIEW_MAX_FILES,
} from '../../shared/skillager-review'
import type { ProjectHost } from '../project-host/project-host'
import {
  preflight,
  UnsupportedSourceError,
} from '../project-file-operations/verified-project-copy-manifest'
import { SkillagerError } from './skillager-port'

export type SkillagerSnapshotHost = Pick<
  ProjectHost,
  | 'hostId'
  | 'stat'
  | 'readdir'
  | 'realpath'
  | 'fileTransfer'
  | 'createDirectoryExclusive'
  | 'exec'
>

/** Captures once; only the CLI, not these copy mechanics, establishes approval identity. */
export async function captureSkillagerTree(
  host: SkillagerSnapshotHost,
  source: HostPath,
  destination: HostPath,
  signal: AbortSignal,
) {
  if (
    host.hostId !== 'local' ||
    source.hostId !== 'local' ||
    destination.hostId !== 'local' ||
    !host.fileTransfer?.readFileChunksNoFollow
  )
    throw new SkillagerError('unavailable', 'Local skill snapshot access is unavailable.')
  const transfer = host.fileTransfer
  const read = async function* (path: HostPath, at: AbortSignal) {
    try {
      yield* transfer.readFileChunksNoFollow!(path, { signal: at })
    } catch (error) {
      if (at.aborted) throw error
      throw new SkillagerError(
        'review-refused',
        'The skill path changed or secure local file access is unavailable. Review cannot continue.',
      )
    }
  }
  const confined = async (path: HostPath): Promise<void> => {
    signal.throwIfAborted()
    if (!hostPathEquals(await host.realpath(path), path))
      throw new SkillagerError(
        'review-refused',
        'A skill path is a symbolic link or changed during review.',
      )
  }
  await confined(source)
  const plan = await preflight(
    {
      ...host,
      stat: (path) => host.stat(path),
      readdir: (path) => host.readdir(path),
      readFileChunks: read,
    },
    source,
    signal,
    {
      maxEntries: SKILLAGER_REVIEW_MAX_FILES,
      maxDepth: 32,
      maxFileBytes: SKILLAGER_REVIEW_FILE_BYTES,
      maxTotalBytes: SKILLAGER_REVIEW_MAX_BYTES,
    },
  ).catch((error: unknown) => {
    if (error instanceof UnsupportedSourceError)
      throw new SkillagerError(
        'review-refused',
        'This tree contains unsupported entries or exceeds review limits (512 entries, 8 MiB per file, 32 MiB total).',
      )
    throw error
  })
  const bytes = new Map<string, Uint8Array>()
  for (const entry of plan.entries) {
    signal.throwIfAborted()
    const parts = entry.relativePath ? entry.relativePath.split('/') : []
    const from = joinHostPath(source, ...parts)
    const to = joinHostPath(destination, ...parts)
    await confined(from)
    const before = await host.stat(from)
    if (before.type !== (entry.type === 'directory' ? 'dir' : 'file'))
      throw new SkillagerError('stale-review', 'The skill tree changed. Review it again.')
    if (entry.type === 'directory') {
      await host.createDirectoryExclusive(to, { mode: 0o755, signal })
      continue
    }
    let size = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of read(from, signal)) {
      size += chunk.byteLength
      if (size > entry.size || size > SKILLAGER_REVIEW_FILE_BYTES)
        throw new SkillagerError(
          'output-limit',
          'The skill file changed or exceeds the review limit.',
        )
      chunks.push(Uint8Array.from(chunk))
    }
    await confined(from)
    const after = await host.stat(from)
    if (
      size !== entry.size ||
      after.type !== 'file' ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new SkillagerError('stale-review', 'The skill tree changed. Review it again.')
    const captured = Buffer.concat(chunks)
    bytes.set(entry.relativePath, captured)
    await transfer.writeFileChunksExclusive(
      to,
      (async function* () {
        yield await Promise.resolve(captured)
      })(),
      { mode: entry.mode, signal },
    )
  }
  if (!bytes.has('SKILL.md'))
    throw new SkillagerError('review-refused', 'This skill has no reviewable SKILL.md.')
  return {
    bytes,
    entries: plan.entries,
    files: plan.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({
        entry: entry.relativePath,
        size: entry.size,
        executable: entry.mode === 0o755,
      })),
  }
}
