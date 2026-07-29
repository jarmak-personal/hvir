import {
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type DirEntry,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { IndexedFilename } from './filename-search-policy'

export const FILENAME_SEARCH_ENTRY_LIMIT = 10_000
export const FILENAME_SEARCH_DIRECTORY_LIMIT = 2_000
export const FILENAME_SEARCH_DEPTH_LIMIT = 64
export const FILENAME_SEARCH_TIME_LIMIT_MS = 15_000

export interface FilenameEnumerationLimits {
  readonly entries: number
  readonly directories: number
  readonly depth: number
  readonly timeMs: number
}

export interface FilenameEnumeration {
  readonly files: readonly IndexedFilename[]
  readonly truncated: boolean
}

export interface GitIgnorePort {
  ignoredEntries(
    root: HostPath,
    directory: HostPath,
    names: readonly string[],
  ): Promise<ReadonlySet<string>>
}

export interface EnumerateFilenamesOptions {
  readonly host: Pick<
    ProjectHost,
    'hostId' | 'connectionState' | 'readdir' | 'realpath' | 'stat'
  >
  readonly root: HostPath
  readonly canonicalRoot: HostPath
  readonly includeIgnored: boolean
  readonly gitIgnore?: GitIgnorePort
  readonly signal: AbortSignal
  readonly limits?: Partial<FilenameEnumerationLimits>
}

interface PendingDirectory {
  readonly display: HostPath
  readonly canonical: HostPath
  readonly depth: number
}

const DEFAULT_LIMITS: FilenameEnumerationLimits = {
  entries: FILENAME_SEARCH_ENTRY_LIMIT,
  directories: FILENAME_SEARCH_DIRECTORY_LIMIT,
  depth: FILENAME_SEARCH_DEPTH_LIMIT,
  timeMs: FILENAME_SEARCH_TIME_LIMIT_MS,
}

/** Bounded, host-neutral traversal. The renderer never participates in the walk. */
export async function enumerateFilenames({
  host,
  root,
  canonicalRoot,
  includeIgnored,
  gitIgnore,
  signal,
  limits: overrides,
}: EnumerateFilenamesOptions): Promise<FilenameEnumeration> {
  assertSameHost(root, canonicalRoot, host.hostId)
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  validateLimits(limits)
  const files: IndexedFilename[] = []
  const pending: PendingDirectory[] = [
    { display: root, canonical: canonicalRoot, depth: 0 },
  ]
  const visitedDirectories = new Set([pathKey(canonicalRoot)])
  let entriesVisited = 0
  let directoriesVisited = 0
  let truncated = false
  const deadline = Date.now() + limits.timeMs

  while (pending.length > 0) {
    throwIfAborted(signal)
    if (
      entriesVisited >= limits.entries ||
      directoriesVisited >= limits.directories ||
      Date.now() >= deadline
    ) {
      truncated = true
      break
    }
    const directory = pending.shift()!
    directoriesVisited++
    let entries: readonly DirEntry[]
    try {
      entries = await waitForHost(host.readdir(directory.canonical), signal, deadline)
    } catch (error) {
      if (isDeadline(error)) {
        truncated = true
        break
      }
      if (directory.depth === 0 || signal.aborted) throw error
      continue
    }
    const candidates = entries
      .filter((entry) => validEntryName(entry.name) && entry.name !== '.git')
      .sort((left, right) => compareName(left.name, right.name))
    const remaining = limits.entries - entriesVisited
    if (candidates.length > remaining) truncated = true
    const bounded = candidates.slice(0, remaining)
    entriesVisited += bounded.length
    let ignored = new Set<string>()
    if (!includeIgnored && gitIgnore) {
      try {
        ignored = new Set(
          await ignoredNames(
            gitIgnore,
            canonicalRoot,
            directory.canonical,
            bounded.map((entry) => entry.name),
            signal,
            deadline,
          ),
        )
      } catch (error) {
        if (!isDeadline(error)) throw error
        truncated = true
        break
      }
    }

    for (const entry of bounded) {
      if (ignored.has(entry.name)) continue
      const display = joinHostPath(directory.display, entry.name)
      const canonical = joinHostPath(directory.canonical, entry.name)
      if (entry.type === 'file') {
        files.push(indexedFile(root, display))
        continue
      }
      if (entry.type === 'dir') {
        if (directory.depth >= limits.depth) {
          truncated = true
          continue
        }
        queueDirectory(
          pending,
          visitedDirectories,
          display,
          canonical,
          directory.depth + 1,
        )
        continue
      }
      if (entry.type !== 'symlink') continue
      try {
        const target = await waitForHost(host.realpath(canonical), signal, deadline)
        if (!insideRoot(target, canonicalRoot)) continue
        const stat = await waitForHost(host.stat(target), signal, deadline)
        if (stat.type === 'file') files.push(indexedFile(root, display))
        else if (stat.type === 'dir') {
          if (directory.depth >= limits.depth) truncated = true
          else
            queueDirectory(
              pending,
              visitedDirectories,
              display,
              target,
              directory.depth + 1,
            )
        }
      } catch (error) {
        if (isDeadline(error)) {
          truncated = true
          pending.length = 0
          break
        }
        if (signal.aborted) throw error
        // Broken and inaccessible links match the existing tree's non-openable behavior.
      }
    }
  }
  return { files, truncated }
}

async function ignoredNames(
  port: GitIgnorePort,
  root: HostPath,
  directory: HostPath,
  names: readonly string[],
  signal: AbortSignal,
  deadline: number,
): Promise<ReadonlySet<string>> {
  const ignored = new Set<string>()
  for (let index = 0; index < names.length; index += 512) {
    const batch = await waitForHost(
      port.ignoredEntries(root, directory, names.slice(index, index + 512)),
      signal,
      deadline,
    )
    for (const name of batch) ignored.add(name)
  }
  return ignored
}

function queueDirectory(
  pending: PendingDirectory[],
  visited: Set<string>,
  display: HostPath,
  canonical: HostPath,
  depth: number,
): void {
  const key = pathKey(canonical)
  if (visited.has(key)) return
  visited.add(key)
  pending.push({ display, canonical, depth })
}

function indexedFile(root: HostPath, path: HostPath): IndexedFilename {
  const parent = dirnameHostPath(path)
  return {
    path,
    name: path.path.slice(path.path.lastIndexOf('/') + 1),
    parentPath: hostPathEquals(parent, root) ? '.' : relativeProjectPath(root, parent),
  }
}

function relativeProjectPath(root: HostPath, path: HostPath): string {
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return path.path.slice(prefix.length)
}

function insideRoot(path: HostPath, root: HostPath): boolean {
  if (path.hostId !== root.hostId) return false
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return path.path === root.path || path.path.startsWith(prefix)
}

function assertSameHost(root: HostPath, canonicalRoot: HostPath, hostId: string): void {
  if (root.hostId !== hostId || canonicalRoot.hostId !== hostId) {
    throw new Error('Filename search path belongs to another host')
  }
}

function validEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  )
}

function validateLimits(limits: FilenameEnumerationLimits): void {
  if (
    !Number.isSafeInteger(limits.entries) ||
    limits.entries < 1 ||
    !Number.isSafeInteger(limits.directories) ||
    limits.directories < 1 ||
    !Number.isSafeInteger(limits.depth) ||
    limits.depth < 0 ||
    !Number.isSafeInteger(limits.timeMs) ||
    limits.timeMs < 1
  ) {
    throw new Error('Invalid filename search limits')
  }
}

function compareName(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase())
  return folded || left.localeCompare(right)
}

function pathKey(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}

class FilenameSearchDeadlineError extends Error {}

function isDeadline(error: unknown): error is FilenameSearchDeadlineError {
  return error instanceof FilenameSearchDeadlineError
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Search cancelled')
}

function waitForHost<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  throwIfAborted(signal)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new FilenameSearchDeadlineError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = (): void => finish(() => reject(abortReason(signal)))
    const timer = setTimeout(
      () => finish(() => reject(new FilenameSearchDeadlineError())),
      remaining,
    )
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    )
  })
}
