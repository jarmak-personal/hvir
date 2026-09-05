import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  DISPOSABLE_ROLES,
  POLICY_PATH,
  physicalLines,
  ruleFor,
} from './architecture-policy.mjs'

export function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}
const trees = new Map()
const objects = new Map()
function tree(root, revision) {
  const key = `${root}:${revision}`
  if (!trees.has(key))
    trees.set(
      key,
      new Map(
        git(root, ['ls-tree', '-r', '-z', revision])
          .split('\0')
          .filter(Boolean)
          .map((row) => {
            const [metadata, path] = row.split('\t')
            return [path, { mode: metadata.split(' ')[0], oid: metadata.split(' ')[2] }]
          }),
      ),
    )
  return trees.get(key)
}
function prefetch(root, revision, paths) {
  const entries = tree(root, revision)
  const ids = [
    ...new Set(
      [...paths]
        .map((path) => entries.get(path)?.oid)
        .filter((id) => id && !objects.has(`${root}:${id}`)),
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
    if (actual !== id || type !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Unreadable required Git blob')
    objects.set(`${root}:${id}`, Buffer.from(batch.subarray(end + 1, end + 1 + size)))
    position = end + size + 2
  }
}
export function blob(root, revision, path) {
  const entry = tree(root, revision).get(path)
  if (!entry) return null
  prefetch(root, revision, [path])
  return objects.get(`${root}:${entry.oid}`)
}
export function fullCommit(root, ref) {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error('Required revision is not a full commit')
  return sha
}
export function requireAncestor(root, base, head) {
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
const DATA_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.html',
  '.svg',
  '.png',
  '.gif',
  '.icns',
  '.plist',
  '.toml',
  '.csv',
  '.gyp',
  '.apparmor',
  '.dev',
  '.gitignore',
  '.prettierignore',
])
function isSource(path, bytes, policy) {
  if (policy.extensions.includes(extname(path))) return true
  const first = bytes.subarray(0, 200).toString().split('\n')[0]
  if (/^#!.*\b(?:sh|bash|zsh)(?:\s|$)/.test(first)) return true
  if (first.startsWith('#!') || (extname(path) && !DATA_EXTENSIONS.has(extname(path)))) {
    throw new Error(
      `Unclassified source language: ${path}; add an explicit policy disposition`,
    )
  }
  return false
}
function inScope(path, policy) {
  return !path.includes('/') || policy.roots.some((root) => path.startsWith(`${root}/`))
}
function disposable(path) {
  if (path.split('/').some((part) => Object.hasOwn(DISPOSABLE_ROLES, part))) return true
  return /^packages\/[^/]+\/build(?:\/|$)/.test(path)
}

export function collectInventory(root, policy, revision = null) {
  root = realpathSync(root)
  const result = new Map()
  const tracked = git(root, ['ls-tree', '-r', '--name-only', '-z', revision ?? 'HEAD'])
    .split('\0')
    .filter(Boolean)
  function add(path, bytes) {
    if (disposable(path))
      throw new Error(`Tracked maintained path hidden by disposable role: ${path}`)
    if (!isSource(path, bytes, policy)) return
    if (!inScope(path, policy)) throw new Error(`Source outside declared roots: ${path}`)
    result.set(path, bytes)
  }
  if (revision) {
    prefetch(root, revision, tracked)
    function resolveAlias(path, seen = new Set()) {
      if (seen.has(path)) throw new Error(`Cyclic source alias: ${path}`)
      seen.add(path)
      const target = relative(
        root,
        resolve(root, path, '..', blob(root, revision, path).toString()),
      ).replaceAll('\\', '/')
      if (
        target.startsWith('../') ||
        !target ||
        !tracked.some((p) => p === target || p.startsWith(`${target}/`))
      )
        throw new Error(`Unresolved or escaping source alias: ${path}`)
      if (tree(root, revision).get(target)?.mode === '120000') resolveAlias(target, seen)
    }
    const modes = git(root, ['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean)
    for (const row of modes) {
      const [metadata, path] = row.split('\t')
      const bytes = blob(root, revision, path)
      if (metadata.startsWith('120000')) {
        resolveAlias(path)
      } else add(path, bytes)
    }
    return result
  }
  const owned = new Set(tracked)
  const visited = new Set()
  function walk(path) {
    const absolute = join(root, path)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) {
      let target
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
    if (disposable(path)) {
      if ([...owned].some((p) => p === path || p.startsWith(`${path}/`)))
        throw new Error(`Tracked files hidden by disposable role: ${path}`)
      return
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute).sort())
        walk(path ? `${path}/${entry}` : entry)
    } else if (info.isFile()) add(path, readFileSync(absolute))
    else throw new Error(`Unreadable source entry: ${path}`)
  }
  for (const entry of readdirSync(root).sort()) walk(entry)
  return result
}

export function comparisonCounts(root, inventory, revisions) {
  for (const revision of revisions) prefetch(root, revision, inventory.keys())
  return new Map(
    [...inventory.keys()].map((path) => [
      path,
      revisions.flatMap((revision) => {
        const bytes = blob(root, revision, path)
        return bytes === null ? [] : [physicalLines(bytes)]
      }),
    ]),
  )
}

// Only accepted v2 first-parent snapshots establish the renewed historical ratchet.
// Retain these counts even across deletion/reintroduction; pre-bootstrap history cannot
// retroactively establish stricter limits than the migration's actual comparison base.
export function acceptedRatchetCounts(root, policy, base, counts) {
  for (const entry of policy.budgets.filter((e) =>
    ['stricter', 'transitional'].includes(e.kind),
  )) {
    const history = git(root, [
      'log',
      '--first-parent',
      '--format=%H',
      base,
      '--',
      entry.path,
      POLICY_PATH,
    ])
      .split('\n')
      .filter(Boolean)
    const values = [...(counts.get(entry.path) ?? [])]
    for (const revision of history) {
      prefetch(root, revision, [POLICY_PATH, entry.path])
      const bytes = blob(root, revision, POLICY_PATH)
      if (!bytes) continue
      const accepted = JSON.parse(bytes.toString())
      if (accepted.version !== 2) break
      const rule = ruleFor(accepted, entry.path)
      if (!['stricter', 'transitional'].includes(rule.kind)) continue
      const source = blob(root, revision, entry.path)
      if (source !== null) values.push(physicalLines(source))
    }
    counts.set(entry.path, values)
  }
  return counts
}

export function validateGeneratedOwnership(policy, read) {
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
