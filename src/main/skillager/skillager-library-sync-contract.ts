import {
  containsHostPath,
  hostPathEquals,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import {
  SKILLAGER_INVENTORY_LIMIT,
  type SkillagerLibrary,
  type SkillagerTrust,
} from '../../shared/skillager'
import {
  SKILLAGER_SYNC_OUTCOMES,
  type SkillagerLibraryLineage,
  type SkillagerSyncCompletion,
  type SkillagerSyncCoverage,
  type SkillagerSyncItem,
  type SkillagerSyncOrigin,
  type SkillagerSyncStatus,
} from '../../shared/skillager-library-sync'
import { SkillagerError } from './skillager-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'

const TRUST = [
  'reviewed',
  'trusted',
  'pinned',
  'blocked',
  'discovered',
  'lint_blocked',
  'unknown',
] as const
const APPROVED = ['reviewed', 'trusted', 'pinned'] as const

/** Closed public projections; neither editable provenance nor paths acquire authority here. */
export function parseSkillagerSyncStatus(
  payload: unknown,
  code: number | null,
  library: SkillagerLibrary,
  context: HostPath,
): SkillagerSyncStatus {
  const raw = object(payload)
  if (raw.schema !== 'skillager.library-sync-status.v1') malformed()
  const refused = raw.status === 'refused'
  if ((refused && code !== 2) || (!refused && (code !== 0 || raw.status !== undefined)))
    malformed()
  const base = observation(raw, library, context, refused)
  const lineages = array(raw.lineages).map((value) => lineage(value, library))
  const candidates = array(raw.candidates).map((value) => {
    const item = object(value)
    return {
      sourceIdentity: identity(item.source_identity),
      canonicalSkillId: skillId(item.canonical_skill_id, library),
      state: oneOf(item.state, [
        'eligible-create',
        'eligible-update',
        'current',
        'conflict',
        'skipped',
        'pending',
        'unavailable',
        'failed',
      ] as const),
      reason: reason(item.reason_code),
    }
  })
  unique(lineages.map((item) => item.id))
  unique(lineages.map((item) => item.sourceIdentity))
  unique(lineages.map((item) => item.canonical.skillId))
  unique(candidates.map((item) => item.sourceIdentity))
  const origins = lineages.flatMap((item) => item.origins.map((origin) => origin.id))
  unique(origins)
  if (origins.length + lineages.length > SKILLAGER_INVENTORY_LIMIT) limit()
  if (refused) {
    if (lineages.length || candidates.length) malformed()
  } else if (
    !base.library ||
    !base.context ||
    base.coverage.selectedSources !== candidates.length ||
    base.coverage.processedSources !== candidates.length
  )
    malformed()
  return { ...base, status: refused ? 'refused' : 'observed', lineages, candidates }
}

export function parseSkillagerSyncCompletion(
  payload: unknown,
  code: number | null,
  library: SkillagerLibrary,
  context: HostPath,
): SkillagerSyncCompletion {
  const raw = object(payload)
  if (raw.schema !== 'skillager.library-sync.v1') malformed()
  const status = oneOf(raw.status, [
    'completed',
    'partial',
    'refused',
    'uncertain',
  ] as const)
  if (code !== (status === 'completed' ? 0 : 2)) malformed()
  const base = observation(raw, library, context, status === 'refused')
  const items = array(raw.items).map((value): SkillagerSyncItem => {
    const item = object(value)
    const result: SkillagerSyncItem = {
      sourceIdentity: identity(item.source_identity),
      originIds: array(item.origin_ids).map(identity),
      lineageId: optional(item.lineage_id, identity),
      canonicalSkillId: skillId(item.canonical_skill_id, library),
      outcome: oneOf(item.outcome, SKILLAGER_SYNC_OUTCOMES),
      phase: oneOf(item.phase, [
        'not-started',
        'prepared',
        'published',
        'committed',
        'accepted',
        'unknown',
      ] as const),
      acceptedHash: optional(item.accepted_hash, hash),
      reason: reason(item.reason_code),
      repair: oneOf(item.repair, [
        'none',
        'observe',
        'accept-pending',
        'resolve-conflict',
      ] as const),
      recoveryPath: optional(item.recovery_path, path),
    }
    if (
      ['created', 'updated', 'unchanged'].includes(result.outcome) &&
      (result.phase !== 'accepted' ||
        !result.acceptedHash ||
        !result.lineageId ||
        !result.canonicalSkillId)
    )
      malformed()
    return result
  })
  unique(items.map((item) => item.sourceIdentity))
  const origins = items.flatMap((item) => item.originIds)
  unique(origins)
  if (origins.length > SKILLAGER_INVENTORY_LIMIT) limit()
  const counts = {} as Record<(typeof SKILLAGER_SYNC_OUTCOMES)[number], number>
  const rawCounts = object(raw.counts)
  for (const name of SKILLAGER_SYNC_OUTCOMES) {
    counts[name] = count(rawCounts[name])
    if (counts[name] !== items.filter((item) => item.outcome === name).length) malformed()
  }
  if ((!base.library || !base.context) && (status !== 'refused' || items.length))
    malformed()
  if (
    base.coverage.selectedSources !== items.length &&
    !(status === 'refused' && !items.length)
  )
    malformed()
  if (
    status === 'completed' &&
    (!base.coverage.complete || counts.conflict || counts.failed || counts.uncertain)
  )
    malformed()
  if ((status === 'uncertain') !== counts.uncertain > 0) malformed()
  return { ...base, status, counts, items }
}

function observation(
  raw: Record<string, unknown>,
  library: SkillagerLibrary,
  context: HostPath,
  refused: boolean,
) {
  let selected: SkillagerLibrary | undefined
  let observedContext: HostPath | undefined
  if (raw.library !== null) {
    const value = object(raw.library)
    if (
      value.library_id !== library.id ||
      !hostPathEquals(path(value.root), library.root)
    )
      throw new SkillagerError(
        'library-changed',
        'Skillager reported a different personal library. Check the connection again.',
      )
    oneOf(value.git_mode, ['system', 'disabled'] as const)
    selected = library
  } else if (!refused) malformed()
  if (raw.context !== null) {
    const value = object(raw.context)
    if (value.discovery !== 'effective-local') malformed()
    observedContext = path(value.project_root)
    if (!hostPathEquals(observedContext, context))
      throw new SkillagerError(
        'invalid-request',
        'Skillager resolved a different local project. Open that project explicitly before syncing.',
      )
  } else if (!refused) malformed()
  const value = object(raw.coverage)
  const coverage: SkillagerSyncCoverage = {
    discoveredOrigins: count(value.discovered_origins),
    approvedOrigins: count(value.approved_origins),
    selectedSources: count(value.selected_sources),
    processedSources: count(value.processed_sources),
    complete: boolean(value.complete),
    discoveryErrors: count(value.discovery_error_count),
  }
  if (
    coverage.approvedOrigins > coverage.discoveredOrigins ||
    coverage.processedSources > coverage.selectedSources ||
    (coverage.complete &&
      (coverage.discoveryErrors ||
        coverage.processedSources !== coverage.selectedSources))
  )
    malformed()
  return {
    library: selected,
    context: observedContext,
    coverage,
    reason: reason(raw.reason_code),
  }
}

function lineage(payload: unknown, library: SkillagerLibrary): SkillagerLibraryLineage {
  const raw = object(payload),
    source = object(raw.source_approval),
    canonical = object(raw.canonical)
  if (
    raw.schema !== 'skillager.library-lineage.v1' ||
    canonical.library_id !== library.id ||
    canonical.reuse !== 'all-projects'
  )
    malformed()
  const id = skillId(canonical.skill_id, library)
  if (!id) malformed()
  const canonicalPath = path(canonical.path)
  if (!hostPathEquals(canonicalPath, skillagerLibrarySkillRoot(library, id))) malformed()
  const result: SkillagerLibraryLineage = {
    id: identity(raw.lineage_id),
    sourceIdentity: identity(raw.source_identity),
    sourceApproval: {
      evidenceId: identity(source.evidence_id),
      decisionSkillId: text(source.decision_skill_id, 1024),
      scope: oneOf(source.scope, ['project', 'global'] as const),
      state: oneOf(source.state, APPROVED),
      contentHash: hash(source.content_hash),
      lintOverride: boolean(source.lint_override),
      riskOverride: boolean(source.risk_override),
    },
    canonical: {
      libraryId: library.id,
      skillId: id,
      path: canonicalPath,
      acceptedHash: optional(canonical.accepted_hash, hash),
      workingHash: optional(canonical.working_hash, hash),
      acceptance: oneOf(canonical.acceptance, [
        'accepted',
        'pending',
        'missing',
        'unavailable',
      ] as const),
      trust: trust(canonical.trust),
      reuse: 'all-projects',
      gitCommit: optional(canonical.git_commit, (value) => {
        const commit = text(value, 64)
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) malformed()
        return commit
      }),
    },
    origins: array(raw.origins).map(origin),
    preservation: oneOf(raw.preservation, [
      'verified',
      'pending',
      'conflict',
      'unavailable',
    ] as const),
    reason: reason(raw.reason_code),
  }
  if (!result.origins.length) malformed()
  const current = result.canonical
  if (
    current.acceptance === 'accepted' &&
    (!current.acceptedHash ||
      current.acceptedHash !== current.workingHash ||
      !APPROVED.some((value) => value === current.trust))
  )
    malformed()
  if (
    result.preservation === 'verified' &&
    (current.acceptance !== 'accepted' ||
      current.acceptedHash !== result.sourceApproval.contentHash)
  )
    malformed()
  return result
}

function origin(payload: unknown): SkillagerSyncOrigin {
  const raw = object(payload),
    provenance = object(raw.provenance),
    observed = object(raw.observation)
  const root = path(raw.path),
    entrypoint = path(raw.entrypoint)
  if (!containsHostPath(root, entrypoint) || hostPathEquals(root, entrypoint)) malformed()
  const native = raw.native === null ? undefined : object(raw.native)
  const nativeScope = native
    ? oneOf(native.scope, ['project', 'global'] as const)
    : undefined
  const projectRoot = native ? optional(native.project_root, path) : undefined
  if (native && (nativeScope === 'project') !== Boolean(projectRoot)) malformed()
  return {
    id: identity(raw.origin_id),
    skillId: text(raw.skill_id, 1024),
    sourceType: text(raw.source_type, 128),
    path: root,
    entrypoint,
    native: native
      ? { agent: text(native.agent, 128), scope: nativeScope!, projectRoot }
      : undefined,
    provenance: {
      collection: optional(provenance.collection, (value) => text(value, 1024)),
      package: optional(provenance.package, (value) => text(value, 1024)),
      version: optional(provenance.version, (value) => text(value, 1024)),
      editable: optional(provenance.editable, boolean),
    },
    observation: {
      status: oneOf(observed.status, [
        'current',
        'changed',
        'blocked',
        'unapproved',
        'missing',
        'unavailable',
        'not-observed',
      ] as const),
      contentHash: optional(observed.content_hash, hash),
      trust: optional(observed.trust, trust),
      approvalEvidenceId: optional(observed.approval_evidence_id, identity),
    },
  }
}

function skillId(value: unknown, library: SkillagerLibrary): string | undefined {
  return optional(value, (value) => {
    const id = text(value, 68)
    try {
      skillagerLibrarySkillRoot(library, id)
    } catch {
      malformed()
    }
    return id
  })
}
function path(value: unknown): HostPath {
  const valuePath = text(value, 16384)
  if (!valuePath.startsWith('/') || localPath(valuePath).path !== valuePath) malformed()
  return localPath(valuePath)
}
function hash(value: unknown): string {
  const result = text(value, 64)
  if (!/^[a-f0-9]{64}$/i.test(result)) malformed()
  return result
}
function identity(value: unknown): string {
  return text(value, 128)
}
function reason(value: unknown): string | undefined {
  return optional(value, (value) => {
    const code = text(value, 128)
    if (!/^[a-z][a-z0-9-]*$/.test(code)) malformed()
    return code
  })
}
function trust(value: unknown): SkillagerTrust {
  return oneOf(value, TRUST)
}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value == null ? undefined : parse(value)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed()
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return malformed()
  if (value.length > SKILLAGER_INVENTORY_LIMIT) limit()
  return value
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    value.includes('\0')
  )
    return malformed()
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return malformed()
  return value
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : malformed()
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return malformed()
  return value as T
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) malformed()
}
function limit(): never {
  throw new SkillagerError(
    'output-limit',
    'Skillager sync metadata exceeds the supported inventory size.',
  )
}
function malformed(): never {
  throw new SkillagerError(
    'malformed-result',
    'Skillager returned unsupported or malformed sync metadata.',
  )
}
