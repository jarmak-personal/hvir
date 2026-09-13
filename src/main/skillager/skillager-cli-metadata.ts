import { SkillagerError } from './skillager-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
} from '../../shared/host-path'
import type {
  SkillagerProjectStatus,
  SkillagerWorkingStatus,
} from '../../shared/skillager-project'
import {
  SKILLAGER_AGENTS,
  SKILLAGER_INVENTORY_LIMIT,
  SKILLAGER_SEARCH_LIMIT,
  type SkillagerLibrary,
  type SkillagerMetadata,
  type SkillagerTrust,
  type SkillagerWorkspaceExposure,
  type SkillagerAgent,
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

export function parseSkillagerProjectSkills(
  payload: unknown,
  library: SkillagerLibrary,
): readonly SkillagerMetadata[] {
  const data = object(payload),
    action = object(data.action)
  if (array(action.changed, 0).length) malformed()
  const selected = array(data.selected, SKILLAGER_INVENTORY_LIMIT)
  if (object(data.summary).total !== selected.length) malformed()
  const lintBlockedIds = new Set(
    selected.flatMap((item) => {
      const row = object(item)
      return row.trust === 'lint_blocked' ? [string(row.id, 1024)] : []
    }),
  )
  for (const entry of array(action.skipped, SKILLAGER_INVENTORY_LIMIT)) {
    const skipped = object(entry)
    if (
      skipped.reason !== 'lint-blocked; fix source or use --override-lint --reason' ||
      !lintBlockedIds.has(string(skipped.skill_id, 1024))
    )
      malformed()
  }
  const rows = selected.map((item): SkillagerMetadata => {
    const raw = object(item),
      source = object(raw.source)
    if (source.type !== 'project' || source.ownership === 'library') malformed()
    const native = raw.native === undefined ? undefined : object(raw.native)
    const agent = native?.agent ?? source.agent
    if (agent !== undefined && !SKILLAGER_AGENTS.some((item) => item.id === agent))
      malformed()
    if (native && (typeof native.managed !== 'boolean' || native.scope !== 'project'))
      malformed()
    return {
      ...metadata(raw, library),
      projectSkill: {
        path: absolutePath(raw.root),
        agent: agent as SkillagerAgent | undefined,
        managed: native?.managed === true,
      },
    }
  })
  unique(rows)
  return rows
}

/** Doctor's diagnostic exit statuses are structured outcomes, not process failures. */
export function parseSkillagerProjectStatus(
  payload: unknown,
  exitCode: number,
  projectRoot: HostPath,
  agent: SkillagerAgent,
): SkillagerProjectStatus {
  const data = object(payload),
    readiness = object(data.readiness),
    state = object(data.state)
  if (
    data.schema !== 'skillager.doctor.v1' ||
    ![0, 10, 11, 12, 13, 14].includes(exitCode) ||
    data.exit_code !== exitCode ||
    data.agent !== agent
  )
    malformed()
  const observedRoot = absolutePath(data.project)
  if (!hostPathEquals(observedRoot, projectRoot))
    throw new SkillagerError(
      'invalid-request',
      'Skillager resolved a different project. Open that project explicitly before setting it up.',
    )
  const status = string(data.status, 80)
  if (
    !/^[a-z][a-z0-9-]*$/.test(status) ||
    typeof readiness.can_proceed !== 'boolean' ||
    (exitCode === 0 && (status !== 'ready' || !readiness.can_proceed)) ||
    (exitCode !== 0 && status === 'ready')
  )
    malformed()
  const working = object(object(state.artifacts).working_skill).status
  if (
    !['missing', 'present', 'unmanaged', 'drift', 'stale'].includes(string(working, 32))
  )
    malformed()
  const count = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      return malformed()
    return value
  }
  const reviewNeeded = count(object(state.review).needed),
    lintBlocked = count(object(state.lint_blocked).count)
  if (exitCode === 0 && (reviewNeeded > 0 || lintBlocked > 0)) malformed()
  return {
    projectRoot: observedRoot,
    agent,
    status,
    canProceed: exitCode === 0,
    reviewNeeded,
    lintBlocked,
    working: working as SkillagerWorkingStatus,
  }
}

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

/** Public show metadata; never requests or forwards the skill body. */
export function parseSkillagerShow(payload: unknown, library: SkillagerLibrary) {
  const skill = object(object(payload).skill)
  const row = metadata(skill, library)
  if (row.source.ownership !== 'library') malformed()
  const compatibility = skill.compatibility == null ? {} : object(skill.compatibility)
  const declarations: string[] = []
  for (const [label, value] of [
    ['Assumptions', compatibility.assumptions],
    ['Exclusive to', compatibility.exclusive_to],
    ['Incompatible with', compatibility.incompatible_with],
    ['Warnings', compatibility.warnings],
    ['Activation warnings', compatibility.activation_warnings],
    ['Targets', skill.targets],
  ] as const) {
    if (value == null || JSON.stringify(value) === '[]') continue
    const encoded = JSON.stringify(value)
    if (encoded.length > 16_384 || encoded.includes('\\u0000')) malformed()
    declarations.push(`${label}: ${encoded}`)
  }
  return { row, declarations }
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
      expectedSourceHash:
        row.expected_source_hash == null ? undefined : hash(row.expected_source_hash),
      currentHash: row.current_hash == null ? undefined : hash(row.current_hash),
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
    if (
      !id.startsWith('lib/') ||
      source.library_id !== library.id ||
      source.collection !== 'lib'
    )
      malformed()
    const root = absolutePath(row.root)
    let expectedRoot: HostPath
    try {
      expectedRoot = skillagerLibrarySkillRoot(library, id)
    } catch {
      return malformed()
    }
    if (!containsHostPath(library.skillsRoot, root) || root.path !== expectedRoot.path)
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

function hash(value: unknown): string {
  const result = string(value, 64)
  if (!HASH.test(result)) malformed()
  return result
}
