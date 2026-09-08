// Architecture budgets and maintained-source classification share one policy owner.
import { extname, basename } from 'node:path'
import type { Buffer } from 'node:buffer'

export const POLICY_PATH = 'scripts/architecture-hotspots.json'
export const SOURCE_ROOTS = [
  'src',
  'test',
  'scripts',
  'packages',
  'build',
  '.github',
  '.githooks',
  '.agents',
  '.claude',
]
export const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.sh',
  '.bash',
  '.zsh',
  '.c',
  '.h',
]
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
const DISPOSABLE_ROLES: Readonly<Record<string, string>> = {
  node_modules: 'installed dependencies',
  '.git': 'Git internals',
  out: 'disposable build output',
  dist: 'disposable distribution output',
  coverage: 'disposable test coverage',
}

export interface BudgetMetadata {
  path: string
  maxLines: number
  owner: string
  rationale: string
  reconsiderWhen: string
}
export interface ArchitectureBudget extends BudgetMetadata {
  kind: 'stricter' | 'transitional' | 'durable'
  removalIssue?: string
}
export interface GeneratedBudget extends BudgetMetadata {
  generator: string
  inputs: Array<{ path: string; sha256: string }>
  command: string
}
export interface ArchitecturePolicy {
  version: 2
  comfortLines: 500
  defaultMaximum: number
  roots: string[]
  extensions: string[]
  budgets: ArchitectureBudget[]
  generated: GeneratedBudget[]
}
export type ArchitectureRule =
  | ArchitectureBudget
  | (GeneratedBudget & { kind: 'generated' })
  | { kind: 'ordinary'; maxLines: number }
export type SourceInventory = Map<string, Buffer>
export type ComparisonCounts = Map<string, number[]>
export interface ArchitectureRow {
  path: string
  category: 'production' | 'test' | 'smoke' | 'tooling' | 'generated'
  lines: number
  governingRule: ArchitectureRule['kind']
  declaredLimit: number
  effectiveLimit: number
  aboveComfort: boolean
  status: 'ok' | 'over'
  exception?: Exclude<ArchitectureRule, { kind: 'ordinary' }>
}

export function disposableDirectory(path: string): boolean {
  return (
    path.split('/').some((part) => Object.hasOwn(DISPOSABLE_ROLES, part)) ||
    /^packages\/[^/]+\/build(?:\/|$)/.test(path)
  )
}

// Configured source extensions always win. These fixed data dispositions are not a
// caller-configurable exclusion list; ignored or untracked unknown source still fails.
export function sourceDisposition(
  path: string,
  policy: ArchitecturePolicy,
): 'source' | 'data' | 'inspect' {
  const extension = extname(path)
  if (policy.extensions.includes(extension)) return 'source'
  if (
    DATA_EXTENSIONS.has(extension) ||
    ['.log', '.tsbuildinfo'].includes(extension) ||
    /^\.env(?:\.[a-zA-Z0-9_-]+)*$/.test(basename(path))
  )
    return 'data'
  return 'inspect'
}
export function isSource(
  path: string,
  bytes: Buffer,
  policy: ArchitecturePolicy,
): boolean {
  if (sourceDisposition(path, policy) === 'source') return true
  const first = bytes.subarray(0, 200).toString().split('\n')[0] ?? ''
  if (/^#!.*\b(?:sh|bash|zsh)(?:\s|$)/.test(first)) return true
  if (
    first.startsWith('#!') ||
    (extname(path) && sourceDisposition(path, policy) !== 'data')
  ) {
    throw new Error(
      `Unclassified source language: ${path}; add an explicit policy disposition`,
    )
  }
  return false
}
export function inScope(path: string, policy: ArchitecturePolicy): boolean {
  return !path.includes('/') || policy.roots.some((root) => path.startsWith(`${root}/`))
}

export function physicalLines(bytes: Uint8Array): number {
  if (!bytes.length) return 0
  let count = 0
  for (const byte of bytes) if (byte === 10) count++
  return count + (bytes[bytes.length - 1] === 10 ? 0 : 1)
}
function closed(
  value: unknown,
  keys: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`Malformed ${label}: unexpected fields`)
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`)
}
function maximum(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Malformed integer maximum')
}
export function repositoryPath(value: unknown): string {
  text(value, 'repository path')
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((p) => !p || p === '..' || p === '.') ||
    /[*?[\]]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error(`Invalid exact repository path: ${value}`)
  return value
}
function uniqueStrings(values: unknown, label: string): asserts values is string[] {
  if (
    !Array.isArray(values) ||
    values.some((v: unknown) => typeof v !== 'string') ||
    new Set(values).size !== values.length
  )
    throw new Error(`Malformed ${label}`)
}
function metadata(entry: Record<string, unknown>): BudgetMetadata {
  maximum(entry.maxLines)
  text(entry.owner, 'owner')
  text(entry.rationale, 'rationale')
  text(entry.reconsiderWhen, 'reconsiderWhen')
  return {
    path: repositoryPath(entry.path),
    maxLines: entry.maxLines,
    owner: entry.owner,
    rationale: entry.rationale,
    reconsiderWhen: entry.reconsiderWhen,
  }
}
export function validatePolicy(value: unknown): ArchitecturePolicy {
  closed(
    value,
    [
      'version',
      'comfortLines',
      'defaultMaximum',
      'roots',
      'extensions',
      'budgets',
      'generated',
    ],
    'policy',
  )
  if (value.version !== 2 || value.comfortLines !== 500)
    throw new Error('Unsupported architecture policy version or comfort target')
  maximum(value.defaultMaximum)
  uniqueStrings(value.roots, 'roots')
  uniqueStrings(value.extensions, 'extensions')
  const roots = value.roots,
    extensions = value.extensions
  if (
    SOURCE_ROOTS.some((root) => !roots.includes(root)) ||
    SOURCE_EXTENSIONS.some((ext) => !extensions.includes(ext))
  )
    throw new Error('Required maintained source roots/extensions cannot be excluded')
  roots.forEach(repositoryPath)
  if (extensions.some((ext) => !/^\.[a-z]+$/.test(ext)))
    throw new Error('Malformed source extension')
  if (!Array.isArray(value.budgets) || !Array.isArray(value.generated))
    throw new Error('Missing classifications')
  const defaultMaximum = value.defaultMaximum
  const budgets = value.budgets.map((entry: unknown): ArchitectureBudget => {
    closed(
      entry,
      [
        'path',
        'kind',
        'maxLines',
        'owner',
        'rationale',
        'reconsiderWhen',
        'removalIssue',
      ],
      'budget',
    )
    const common = metadata(entry)
    if (
      entry.kind !== 'stricter' &&
      entry.kind !== 'transitional' &&
      entry.kind !== 'durable'
    )
      throw new Error(`Unknown budget kind: ${common.path}`)
    if ((entry.kind === 'stricter') !== common.maxLines <= defaultMaximum)
      throw new Error(`Inconsistent budget maximum: ${common.path}`)
    if (entry.kind === 'transitional') {
      text(entry.removalIssue, 'current removal issue')
      if (!/^#[1-9]\d*$/.test(entry.removalIssue))
        throw new Error(`Missing current removal issue: ${common.path}`)
      return { ...common, kind: entry.kind, removalIssue: entry.removalIssue }
    }
    if (entry.removalIssue !== undefined)
      throw new Error(`Unexpected removal issue: ${common.path}`)
    return { ...common, kind: entry.kind }
  })
  const generated = value.generated.map((entry: unknown): GeneratedBudget => {
    closed(
      entry,
      [
        'path',
        'maxLines',
        'owner',
        'rationale',
        'reconsiderWhen',
        'generator',
        'inputs',
        'command',
      ],
      'generated declaration',
    )
    const common = metadata(entry),
      generator = repositoryPath(entry.generator)
    if (generator === common.path)
      throw new Error('Generated output cannot own its generator')
    text(entry.command, 'regeneration command')
    if (!Array.isArray(entry.inputs) || !entry.inputs.length)
      throw new Error('Missing generated inputs')
    const inputs = entry.inputs.map((input: unknown) => {
      closed(input, ['path', 'sha256'], 'generated input')
      text(input.sha256, 'generated input identity')
      if (!/^[a-f0-9]{64}$/.test(input.sha256))
        throw new Error('Missing generated input identity')
      return { path: repositoryPath(input.path), sha256: input.sha256 }
    })
    return { ...common, generator, inputs, command: entry.command }
  })
  const paths = new Set<string>()
  for (const entry of [...budgets, ...generated]) {
    if (paths.has(entry.path))
      throw new Error(`Conflicting classification: ${entry.path}`)
    paths.add(entry.path)
  }
  if (
    generated.some((entry) => generated.some((other) => other.path === entry.generator))
  )
    throw new Error('Generator source must be maintained')
  return {
    version: 2,
    comfortLines: 500,
    defaultMaximum,
    roots,
    extensions,
    budgets,
    generated,
  }
}
export function ruleFor(policy: ArchitecturePolicy, path: string): ArchitectureRule {
  const generated = policy.generated.find((entry) => entry.path === path)
  if (generated) return { ...generated, kind: 'generated' }
  return (
    policy.budgets.find((entry) => entry.path === path) ?? {
      kind: 'ordinary',
      maxLines: policy.defaultMaximum,
    }
  )
}
export function isRelaxation(
  before: ArchitectureRule,
  after: ArchitectureRule,
  priorCounts: number[] = [],
): boolean {
  const priorLimit = ['stricter', 'transitional'].includes(before.kind)
    ? Math.min(before.maxLines, ...priorCounts)
    : before.maxLines
  if (after.maxLines > before.maxLines) return true
  if (
    ['stricter', 'transitional'].includes(before.kind) &&
    before.kind !== after.kind &&
    after.maxLines > priorLimit
  )
    return true
  if (
    after.kind === 'generated' &&
    (before.kind !== 'generated' ||
      before.generator !== after.generator ||
      before.command !== after.command ||
      before.owner !== after.owner ||
      JSON.stringify(before.inputs.map((e) => e.path)) !==
        JSON.stringify(after.inputs.map((e) => e.path)))
  )
    return true
  return after.kind === 'durable' && before.kind !== 'durable'
}
export function relaxedPaths(
  before: ArchitecturePolicy,
  after: ArchitecturePolicy,
  paths: Iterable<string>,
  counts: ComparisonCounts = new Map(),
): string[] {
  return [
    ...new Set([
      ...paths,
      ...before.budgets.map((e) => e.path),
      ...after.budgets.map((e) => e.path),
      ...before.generated.map((e) => e.path),
      ...after.generated.map((e) => e.path),
    ]),
  ].filter((path) =>
    isRelaxation(ruleFor(before, path), ruleFor(after, path), counts.get(path)),
  )
}
export function assertCoverageNotReduced(
  before: ArchitecturePolicy,
  after: ArchitecturePolicy,
): void {
  if (
    before.roots.some((root) => !after.roots.includes(root)) ||
    before.extensions.some((ext) => !after.extensions.includes(ext))
  )
    throw new Error('Unauthorized reduction of source coverage')
}
export function readAcceptedPolicy(bytes: Buffer | null): ArchitecturePolicy {
  if (!bytes) throw new Error('Missing accepted architecture policy')
  const raw: unknown = JSON.parse(bytes.toString())
  if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1)
    return validatePolicy(raw)
  const legacy = raw as { limits?: Record<string, unknown>; legacyHotspots?: unknown }
  if (
    !Array.isArray(legacy.legacyHotspots) ||
    legacy.limits?.newProductionModule !== 500 ||
    legacy.limits.testModule !== 1200 ||
    legacy.limits.generatedModule !== 5000
  )
    throw new Error('Unrecognized pre-bootstrap policy')
  const budgets: ArchitectureBudget[] = legacy.legacyHotspots.flatMap(
    (entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new Error('Malformed legacy budget')
      const fields = entry as Record<string, unknown>
      maximum(fields.maxLines)
      text(fields.owner, 'legacy owner')
      text(fields.rationale, 'legacy rationale')
      return fields.maxLines > 1000
        ? []
        : [
            {
              path: repositoryPath(fields.path),
              kind: 'stricter' as const,
              maxLines: fields.maxLines,
              owner: fields.owner,
              rationale: fields.rationale,
              reconsiderWhen: 'Separately accepted ownership policy changes.',
            },
          ]
    },
  )
  return {
    version: 2,
    comfortLines: 500,
    defaultMaximum: 1000,
    roots: SOURCE_ROOTS,
    extensions: SOURCE_EXTENSIONS,
    budgets,
    generated: [],
  }
}
export function evaluateInventory(
  policy: ArchitecturePolicy,
  inventory: SourceInventory,
  comparisonCounts: ComparisonCounts = new Map(),
): ArchitectureRow[] {
  return [...inventory]
    .map(([path, bytes]): ArchitectureRow => {
      const rule = ruleFor(policy, path),
        lines = physicalLines(bytes),
        counts = comparisonCounts.get(path) ?? []
      if (rule.kind === 'transitional' && !counts.length)
        throw new Error(`Missing comparison-base source for transitional budget: ${path}`)
      const effectiveLimit = ['stricter', 'transitional'].includes(rule.kind)
        ? Math.min(rule.maxLines, ...counts)
        : rule.maxLines
      const category =
        rule.kind === 'generated'
          ? 'generated'
          : path.startsWith('src/main/smoke/')
            ? 'smoke'
            : path.startsWith('test/') || /\.(test|spec)\./.test(path)
              ? 'test'
              : path.startsWith('src/')
                ? 'production'
                : 'tooling'
      return {
        path,
        category,
        lines,
        governingRule: rule.kind,
        declaredLimit: rule.maxLines,
        effectiveLimit,
        aboveComfort: lines > policy.comfortLines,
        status: lines > effectiveLimit ? 'over' : 'ok',
        ...(rule.kind === 'ordinary' ? {} : { exception: rule }),
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
