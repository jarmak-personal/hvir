import { createHash } from 'node:crypto'

import {
  isProjectFileEntryName,
  joinHostPath,
  type DirEntry,
  type HostPath,
  type Stat,
} from '../../shared'
import type { ProjectFileMode } from '../project-host'
import type { ProjectFileCopyLimits } from './project-file-copy-limits'
import { normalizeVerifiedProjectEntryMetadata } from './verified-project-entry-metadata'

export interface PlannedEntry {
  readonly relativePath: string
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly mode: ProjectFileMode
  readonly mtimeSeconds: number
}

export interface PlannedTree {
  readonly entries: readonly PlannedEntry[]
  readonly totalBytes: number
}

export interface ManifestRow extends PlannedEntry {
  readonly sha256?: string
}

export interface TreeReadPort {
  stat(path: HostPath): Promise<Stat>
  readdir(path: HostPath): Promise<readonly DirEntry[]>
  readFileChunks(path: HostPath, signal: AbortSignal): AsyncIterable<Uint8Array>
}

export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedSourceError'
  }
}

export async function preflight(
  source: TreeReadPort,
  root: HostPath,
  signal: AbortSignal,
  limits: ProjectFileCopyLimits,
): Promise<PlannedTree> {
  const entries: PlannedEntry[] = []
  let totalBytes = 0
  const visit = async (path: HostPath, relativePath: string, depth: number) => {
    signal.throwIfAborted()
    if (depth > limits.maxDepth) {
      throw new UnsupportedSourceError('The source exceeds the depth limit')
    }
    if (entries.length >= limits.maxEntries) {
      throw new UnsupportedSourceError('The source exceeds the entry limit')
    }
    const stat = await source.stat(path)
    if (stat.type === 'symlink') {
      throw new UnsupportedSourceError(
        `Symbolic links are unsupported${relativePath ? ` at ${relativePath}` : ''}`,
      )
    }
    if (stat.type !== 'file' && stat.type !== 'dir') {
      throw new UnsupportedSourceError(
        `Unsupported filesystem entry${relativePath ? ` at ${relativePath}` : ''}`,
      )
    }
    const entry = plannedEntry(relativePath, stat)
    if (entry.size > limits.maxFileBytes) {
      throw new UnsupportedSourceError('A source file exceeds the 256 MiB limit')
    }
    totalBytes += entry.size
    if (totalBytes > limits.maxTotalBytes) {
      throw new UnsupportedSourceError('The source exceeds the total byte limit')
    }
    entries.push(entry)
    if (entry.type === 'directory') {
      const children = [...(await source.readdir(path))].sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )
      for (const child of children) {
        if (!isProjectFileEntryName(child.name)) {
          throw new UnsupportedSourceError('A source contains an invalid entry name')
        }
        const relative = relativePath ? `${relativePath}/${child.name}` : child.name
        await visit(joinHostPath(path, child.name), relative, depth + 1)
      }
    }
  }
  await visit(root, '', 0)
  return { entries, totalBytes }
}

export async function manifestTree(
  source: TreeReadPort,
  root: HostPath,
  signal: AbortSignal,
  plan: PlannedTree,
): Promise<readonly ManifestRow[]> {
  const rows: ManifestRow[] = []
  for (const expected of plan.entries) {
    signal.throwIfAborted()
    const path = relativeHostPath(root, expected.relativePath)
    const stat = await source.stat(path)
    const actual = plannedEntry(expected.relativePath, stat)
    if (!sameMetadata(expected, actual)) {
      throw new Error('A manifest entry changed type, size, mode, or modification time')
    }
    if (actual.type === 'directory') {
      const expectedChildren = plan.entries
        .filter(
          (entry) =>
            entry.relativePath &&
            parentRelative(entry.relativePath) === expected.relativePath,
        )
        .map((entry) => basenameRelative(entry.relativePath))
        .sort()
      const actualChildren = (await source.readdir(path))
        .map((entry) => entry.name)
        .sort()
      if (JSON.stringify(expectedChildren) !== JSON.stringify(actualChildren)) {
        throw new Error('A directory manifest contains a missing or extra entry')
      }
      rows.push(actual)
      continue
    }
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of source.readFileChunks(path, signal)) {
      bytes += chunk.byteLength
      if (bytes > actual.size) throw new Error('A manifest file grew while hashing')
      hash.update(chunk)
    }
    if (bytes !== actual.size) throw new Error('A manifest file changed while hashing')
    rows.push({ ...actual, sha256: hash.digest('hex') })
  }
  return rows
}

export function relativeHostPath(root: HostPath, relativePath: string): HostPath {
  return relativePath ? joinHostPath(root, ...relativePath.split('/')) : root
}

export function manifestsEqual(
  left: readonly ManifestRow[],
  right: readonly ManifestRow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function plannedEntry(relativePath: string, stat: Stat): PlannedEntry {
  const normalized = normalizeVerifiedProjectEntryMetadata(stat)
  if (!normalized.ok) {
    throw new UnsupportedSourceError(
      normalized.reason === 'unsupported-entry'
        ? 'A manifest contains an unsupported entry'
        : 'A source has unusable metadata',
    )
  }
  return { relativePath, ...normalized.value }
}

function sameMetadata(left: PlannedEntry, right: PlannedEntry): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.type === right.type &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeSeconds === right.mtimeSeconds
  )
}

function parentRelative(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

function basenameRelative(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}
