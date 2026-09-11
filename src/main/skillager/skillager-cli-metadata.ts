import { SkillagerError } from './skillager-port'
import { containsHostPath, joinHostPath, localPath } from '../../shared/host-path'
import {
  SKILLAGER_INVENTORY_LIMIT,
  SKILLAGER_SEARCH_LIMIT,
  type SkillagerLibrary,
  type SkillagerMetadata,
  type SkillagerTrust,
  type SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import type { HostPath } from '../../shared/host-path'

const TRUST = new Set<SkillagerTrust>([
  'reviewed',
  'trusted',
  'pinned',
  'blocked',
  'discovered',
  'lint_blocked',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/i

/** Closed projections: raw scanner/linter text and unreviewed content never cross IPC. */
export function parseSkillagerLibrary(payload: unknown): SkillagerLibrary | undefined {
  const collections = object(object(payload).collections)
  if (collections.lib === undefined) return undefined
  const lib = object(collections.lib)
  if (lib.kind !== 'library' || !UUID.test(string(lib.library_id, 64))) malformed()
  const root = absolutePath(lib.library_root)
  const skillsRoot = absolutePath(lib.path)
  if (skillsRoot.path !== joinHostPath(root, 'skills').path) malformed()
  return { id: string(lib.library_id, 64), root, skillsRoot }
}

export function parseSkillagerInventory(
  payload: unknown,
  library: SkillagerLibrary,
): readonly SkillagerMetadata[] {
  const data = object(payload)
  if (
    data.schema !== 'skillager.collection-index.v1' ||
    data.name !== 'lib' ||
    data.library_id !== library.id ||
    absolutePath(data.path).path !== library.skillsRoot.path
  )
    malformed()
  if (!Array.isArray(data.errors) || data.errors.length > 0) malformed()
  const rows = array(data.skills, SKILLAGER_INVENTORY_LIMIT).map((item) =>
    metadata(item, library),
  )
  if (rows.some((row) => row.source.ownership !== 'library')) malformed()
  unique(rows)
  return rows
}

export function parseSkillagerSearch(
  payload: unknown,
  library: SkillagerLibrary,
  personal: boolean,
): readonly SkillagerMetadata[] {
  const rows = array(payload, SKILLAGER_SEARCH_LIMIT).map((item) =>
    metadata(item, library),
  )
  if (
    personal &&
    rows.some((row) => row.source.ownership !== 'library' || row.exposure !== 'unknown')
  )
    malformed()
  if (rows.some((row) => !['reviewed', 'trusted', 'pinned'].includes(row.trust)))
    malformed()
  unique(rows)
  return rows
}

export function parseSkillagerExposures(
  payload: unknown,
  workspaceRoot: HostPath,
  agent: string,
): readonly SkillagerWorkspaceExposure[] {
  const data = object(payload)
  if (data.schema !== 'skillager.exposures.v1') malformed()
  return array(data.exposures, SKILLAGER_INVENTORY_LIMIT).map((item) => {
    const row = object(item)
    if (
      row.schema !== 'skillager.exposure.v1' ||
      row.agent !== agent ||
      row.scope !== 'project'
    )
      malformed()
    const target = absolutePath(row.target)
    if (!containsHostPath(workspaceRoot, target) || target.path === workspaceRoot.path)
      malformed()
    return {
      id: string(row.exposure_id, 512),
      skillId: optionalString(row.skill_id, 512),
      target,
      mode: string(row.mode, 64),
      status: string(row.status, 64),
    }
  })
}

function metadata(payload: unknown, library: SkillagerLibrary): SkillagerMetadata {
  const row = object(payload)
  const source = object(row.source)
  const id = string(row.id, 512)
  const trust = string(row.trust, 32) as SkillagerTrust
  if (!TRUST.has(trust) || !HASH.test(string(row.content_hash, 64))) malformed()
  const owned = source.ownership === 'library'
  if (owned) {
    const name = id.slice(4)
    if (
      !id.startsWith('lib/') ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
      source.library_id !== library.id ||
      source.collection !== 'lib'
    )
      malformed()
    const root = absolutePath(row.root)
    if (
      !containsHostPath(library.skillsRoot, root) ||
      root.path !== joinHostPath(library.skillsRoot, name).path
    )
      malformed()
  } else if (id.startsWith('lib/')) malformed()
  const scan = row.scan === undefined ? {} : object(row.scan)
  const lint = row.lint === undefined ? {} : object(row.lint)
  return {
    id,
    name: optionalString(row.name, 512) ?? id,
    description: optionalString(row.summary, 4_096) ?? '',
    trust,
    source: {
      type: string(source.type, 64),
      collection: optionalString(source.collection, 256),
      package: optionalString(source.package, 256),
      ownership: owned ? 'library' : 'external',
      libraryId: owned ? library.id : undefined,
    },
    contentHash: string(row.content_hash, 64),
    tags: strings(row.tags ?? [], 100, 128),
    matchReasons: strings(row.reasons ?? [], 32, 128).filter((reason) =>
      /^(?:id|title|name|description|summary|body|tag|tags|source|package|audience|target|targets):[a-z0-9_:-]+$/i.test(
        reason,
      ),
    ),
    exposure: optionalString(row.exposure, 64) ?? 'unknown',
    scanRisk: optionalString(scan.risk, 32),
    lintStatus: typeof lint.ok === 'boolean' ? (lint.ok ? 'ok' : 'blocked') : undefined,
  }
}

function unique(rows: readonly SkillagerMetadata[]): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) malformed()
}

export function parseSkillagerJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return malformed()
  }
}

function absolutePath(value: unknown) {
  const text = string(value, 16_384)
  if (!text.startsWith('/') || text.includes('\0') || text !== localPath(text).path)
    malformed()
  return localPath(text)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed()
  return value as Record<string, unknown>
}

function string(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  )
    return malformed()
  return value
}

function optionalString(value: unknown, max: number): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : string(value, max)
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return malformed()
  if (value.length > max)
    throw new SkillagerError(
      'output-limit',
      'Skillager returned more metadata than this view supports.',
    )
  return value as unknown[]
}

function strings(value: unknown, max: number, length: number): readonly string[] {
  return array(value, max).map((item) => string(item, length))
}

function malformed(): never {
  throw new SkillagerError(
    'malformed-result',
    'Skillager returned unsupported or malformed metadata.',
  )
}
