import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  POLICY_PATH,
  disposableDirectory,
  inScope,
  isSource,
  physicalLines,
  readAcceptedPolicy,
  ruleFor,
  sourceDisposition,
  type ArchitecturePolicy,
  type ComparisonCounts,
  type SourceInventory,
} from './architecture-policy.mts'

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}
export function fullCommit(root: string, ref: string): string {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error('Required revision is not a full commit')
  return sha
}
export function requireAncestor(root: string, base: string, head: string): void {
  if (fullCommit(root, base) !== base || fullCommit(root, head) !== head)
    throw new Error('Comparison requires immutable full SHAs')
  try {
    git(root, ['merge-base', '--is-ancestor', base, head])
  } catch {
    throw new Error(
      `Stale comparison base: ${base} is not an ancestor of ${head}; refresh the target and reverify`,
    )
  }
}
interface TreeEntry {
  mode: string
  oid: string
}

// Each evaluation owns its own cache. Returning a report releases all Git object references;
// no process-global cache survives a candidate or a disposed fixture repository.
export function createArchitectureInventory(repositoryRoot: string) {
  const root = realpathSync(repositoryRoot)
  const trees = new Map<string, Map<string, TreeEntry>>()
  const objects = new Map<string, Buffer>()
  function tree(revision: string): Map<string, TreeEntry> {
    let entries = trees.get(revision)
    if (!entries) {
      entries = new Map(
        git(root, ['ls-tree', '-r', '-z', revision])
          .split('\0')
          .filter(Boolean)
          .map((row) => {
            const [metadata, path] = row.split('\t'),
              [mode, , oid] = (metadata ?? '').split(' ')
            if (!mode || !oid || !path) throw new Error('Malformed required Git tree')
            return [path, { mode, oid }]
          }),
      )
      trees.set(revision, entries)
    }
    return entries
  }
  function prefetch(revision: string, paths: Iterable<string>): void {
    const entries = tree(revision)
    const ids = [
      ...new Set(
        [...paths].flatMap((path) => {
          const id = entries.get(path)?.oid
          return id && !objects.has(id) ? [id] : []
        }),
      ),
    ]
    if (!ids.length) return
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: ids.join('\n') + '\n',
      maxBuffer: 64 * 1024 * 1024,
    })
    let position = 0
    for (const id of ids) {
      const end = batch.indexOf(10, position)
      const [actual, type, sizeText] = batch.subarray(position, end).toString().split(' ')
      const size = Number(sizeText)
      if (
        end < 0 ||
        actual !== id ||
        type !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        end + size + 1 >= batch.length
      )
        throw new Error('Unreadable required Git blob')
      objects.set(id, Buffer.from(batch.subarray(end + 1, end + 1 + size)))
      position = end + size + 2
    }
  }
  function blob(revision: string, path: string): Buffer | null {
    const entry = tree(revision).get(path)
    if (!entry) return null
    prefetch(revision, [path])
    const bytes = objects.get(entry.oid)
    if (!bytes) throw new Error('Unreadable required Git blob')
    return bytes
  }
  function collectInventory(
    policy: ArchitecturePolicy,
    revision: string | null = null,
  ): SourceInventory {
    const result: SourceInventory = new Map()
    const tracked = [...tree(revision ?? fullCommit(root, 'HEAD')).keys()]
    function add(path: string, bytes: Buffer): void {
      if (disposableDirectory(path))
        throw new Error(`Tracked maintained path hidden by disposable role: ${path}`)
      if (!isSource(path, bytes, policy)) return
      if (!inScope(path, policy))
        throw new Error(`Source outside declared roots: ${path}`)
      result.set(path, bytes)
    }
    if (revision) {
      const entries = tree(revision)
      for (const path of entries.keys())
        if (disposableDirectory(path))
          throw new Error(`Tracked files hidden by disposable role: ${path}`)
      // Data/binary bodies have no role in line-count or alias proof.
      const required = [...entries].filter(
        ([path, entry]) =>
          entry.mode === '120000' ||
          entry.mode === '100755' ||
          sourceDisposition(path, policy) !== 'data',
      )
      prefetch(
        revision,
        required.map(([path]) => path),
      )
      function resolveAlias(path: string, seen = new Set<string>()): void {
        if (seen.has(path)) throw new Error(`Cyclic source alias: ${path}`)
        seen.add(path)
        const bytes = blob(revision!, path)
        if (!bytes) throw new Error(`Unresolved source alias: ${path}`)
        const target = relative(
          root,
          resolve(root, path, '..', bytes.toString()),
        ).replaceAll('\\', '/')
        if (
          target.startsWith('../') ||
          !target ||
          !tracked.some((p) => p === target || p.startsWith(`${target}/`))
        )
          throw new Error(`Unresolved or escaping source alias: ${path}`)
        if (entries.get(target)?.mode === '120000') resolveAlias(target, seen)
      }
      for (const [path, entry] of required) {
        if (entry.mode === '120000') resolveAlias(path)
        else {
          const bytes = blob(revision, path)
          if (!bytes) throw new Error(`Unreadable source: ${path}`)
          add(path, bytes)
        }
      }
      return result
    }
    const owned = new Set(tracked),
      visited = new Set<string>()
    function walk(path: string): void {
      const absolute = join(root, path),
        info = lstatSync(absolute)
      if (info.isSymbolicLink()) {
        let target: string
        try {
          target = relative(root, realpathSync(absolute)).replaceAll('\\', '/')
        } catch {
          throw new Error(`Unresolved source alias: ${path}`)
        }
        if (
          target.startsWith('../') ||
          !target ||
          !tracked.some((p) => p === target || p.startsWith(`${target}/`))
        )
          throw new Error(`Escaping or unowned source alias: ${path}`)
        walk(target)
        return
      }
      if (visited.has(path)) return
      visited.add(path)
      if (disposableDirectory(path)) {
        if ([...owned].some((p) => p === path || p.startsWith(`${path}/`)))
          throw new Error(`Tracked files hidden by disposable role: ${path}`)
        return
      }
      if (info.isDirectory())
        for (const entry of readdirSync(absolute).sort()) walk(`${path}/${entry}`)
      else if (info.isFile()) {
        if ((info.mode & 0o111) !== 0 || sourceDisposition(path, policy) !== 'data')
          add(path, readFileSync(absolute))
      } else throw new Error(`Unreadable source entry: ${path}`)
    }
    for (const entry of readdirSync(root).sort()) walk(entry)
    return result
  }
  function comparisonCounts(
    inventory: SourceInventory,
    revisions: string[],
  ): ComparisonCounts {
    for (const revision of revisions) prefetch(revision, inventory.keys())
    return new Map(
      [...inventory.keys()].map((path) => [
        path,
        revisions.flatMap((revision) => {
          const bytes = blob(revision, path)
          return bytes === null ? [] : [physicalLines(bytes)]
        }),
      ]),
    )
  }
  function acceptedRatchetCounts(
    policy: ArchitecturePolicy,
    base: string,
    counts: ComparisonCounts,
  ): ComparisonCounts {
    const entries = policy.budgets.filter((e) =>
      ['stricter', 'transitional'].includes(e.kind),
    )
    if (!entries.length) return counts
    const history = git(root, [
      'log',
      '--first-parent',
      '--format=%H',
      base,
      '--',
      POLICY_PATH,
      ...entries.map((e) => e.path),
    ])
      .split('\n')
      .filter(Boolean)
    for (const revision of history) {
      const bytes = blob(revision, POLICY_PATH)
      if (!bytes) continue
      const version: unknown = JSON.parse(bytes.toString())
      if (
        !version ||
        typeof version !== 'object' ||
        !('version' in version) ||
        version.version !== 2
      )
        break
      const accepted = readAcceptedPolicy(bytes)
      const ratchets = entries.filter((entry) =>
        ['stricter', 'transitional'].includes(ruleFor(accepted, entry.path).kind),
      )
      prefetch(
        revision,
        ratchets.map((e) => e.path),
      )
      for (const entry of ratchets) {
        const source = blob(revision, entry.path)
        if (source !== null)
          counts.set(entry.path, [
            ...(counts.get(entry.path) ?? []),
            physicalLines(source),
          ])
      }
    }
    return counts
  }
  return { blob, collectInventory, comparisonCounts, acceptedRatchetCounts }
}
export type ArchitectureInventory = ReturnType<typeof createArchitectureInventory>
export function collectInventory(
  root: string,
  policy: ArchitecturePolicy,
  revision: string | null = null,
): SourceInventory {
  return createArchitectureInventory(root).collectInventory(policy, revision)
}
export function validateGeneratedOwnership(
  policy: ArchitecturePolicy,
  read: (path: string) => Buffer | null,
): void {
  for (const entry of policy.generated) {
    if (!read(entry.generator))
      throw new Error(`Missing reproducible generator: ${entry.generator}`)
    for (const input of entry.inputs) {
      const bytes = read(input.path)
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== input.sha256)
        throw new Error(`Generated input identity mismatch: ${input.path}`)
    }
  }
}
