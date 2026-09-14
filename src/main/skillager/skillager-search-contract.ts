import { containsHostPath, hostPathEquals } from '../../shared/host-path'
import { isDeepStrictEqual } from 'node:util'
import {
  SKILLAGER_AGENTS,
  SKILLAGER_ACCEPTED_TRUST,
  SKILLAGER_SEARCH_LIMIT,
  SKILLAGER_INVENTORY_LIMIT,
  SKILLAGER_QUERY_BYTES,
  type SkillagerLibrary,
  type SkillagerSearchRequest,
  type SkillagerSearchRows,
  type SkillagerSearchOccurrence,
  type SkillagerSearchIdentity,
} from '../../shared/skillager'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import { SkillagerError } from './skillager-port'
import {
  metadata,
  object,
  string,
  strings,
  array,
  absolutePath,
  malformed,
} from './skillager-cli-metadata'

const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function validateSkillagerSearchRequest(request: SkillagerSearchRequest): void {
  if (
    typeof request.query !== 'string' ||
    !request.query.trim() ||
    Buffer.byteLength(request.query) > SKILLAGER_QUERY_BYTES ||
    request.query.includes('\0') ||
    !['library', 'workspace'].includes(request.scope) ||
    (request.view !== undefined &&
      !['skills', 'copies', 'legacy'].includes(request.view)) ||
    (request.includeInstalled !== undefined &&
      typeof request.includeInstalled !== 'boolean')
  )
    throw new SkillagerError(
      'invalid-request',
      'Enter a search of at most 1,000 UTF-8 bytes with supported options.',
    )
  if (request.scope === 'workspace' && request.workspaceRoot.hostId !== 'local')
    throw new SkillagerError('unavailable', 'Use Your library for an SSH workspace.')
}

/** The CLI owns grouping/ranking. Only closed, bounded metadata enters hvir. */
export function parseSkillagerSearchView(
  payload: unknown,
  code: number | null,
  library: SkillagerLibrary,
  request: SkillagerSearchRequest,
  provided: boolean,
): SkillagerSearchRows {
  const raw = object(payload),
    policy = object(raw.policy),
    context = object(raw.context)
  const preferred =
    request.browseAgent === 'all' ? null : (request.browseAgent ?? request.agent)
  if (
    raw.schema !== 'skillager.search.v1' ||
    raw.limit !== SKILLAGER_SEARCH_LIMIT ||
    policy.view !== (request.view ?? 'skills') ||
    policy.include_installed !== (request.includeInstalled ?? false) ||
    policy.scope !== request.scope ||
    policy.preferred_agent !== preferred ||
    policy.compatible_only !== false
  )
    malformed()
  const observation = context.installed_observation
  if (!['observed', 'provided', 'unknown'].includes(string(observation, 32))) malformed()
  const local = request.workspaceRoot.hostId === 'local'
  if (
    context.project_root !== null &&
    (!local || !hostPathEquals(absolutePath(context.project_root), request.workspaceRoot))
  )
    malformed()
  const values = array(raw.results, SKILLAGER_SEARCH_LIMIT)
  if (raw.status === 'unavailable') {
    if (values.length || ![1, 2].includes(code ?? -1)) malformed()
    const reason = string(raw.reason_code, 80)
    if (reason === 'installed-state-unknown' && code === 2)
      throw new SkillagerError(
        'installed-unknown',
        local
          ? 'Skillager cannot verify which known skills are already installed in this project. Include installed to search with those relationships left unknown.'
          : 'Skills added through hvir could not be fully verified. Include installed to search without hiding them.',
      )
    if (reason === 'library-changed')
      throw new SkillagerError(
        'library-changed',
        'The Skillager library changed. Reconnect to continue.',
      )
    if (['inventory-limit', 'result-limit', 'installed-input-limit'].includes(reason))
      throw new SkillagerError(
        'output-limit',
        'This search exceeds Skillager’s supported metadata size.',
      )
    throw new SkillagerError(
      'unavailable',
      'Skillager could not complete this search observation. Check its local project context and try again.',
    )
  }
  if (
    raw.status !== 'completed' ||
    code !== 0 ||
    raw.reason_code !== null ||
    (provided
      ? observation !== 'provided' || context.project_root !== null
      : local
        ? context.project_root === null || observation === 'provided'
        : context.project_root !== null || observation !== 'unknown') ||
    (!request.includeInstalled && observation === 'unknown')
  )
    malformed()
  const rows = values.map((value) => {
    const item = object(value),
      row = metadata(item, library),
      search = object(item.search)
    if (
      !SKILLAGER_ACCEPTED_TRUST.some((trust) => trust === row.trust) ||
      (request.scope === 'library' &&
        (row.source.ownership !== 'library' || row.exposure !== 'unknown'))
    )
      malformed()
    const canonical = canonicalIdentity(search.canonical, library)
    const selected = occurrence(search.occurrence)
    const match = object(search.match),
      matched = occurrence(match.occurrence)
    if (
      identity(match.occurrence_id) !== matched.id ||
      !['library', 'source', 'project-original'].includes(matched.kind)
    )
      malformed()
    if (
      selected.id === matched.id &&
      (!isDeepStrictEqual(selected, matched) ||
        item.content_hash !== match.content_hash ||
        item.id !== match.skill_id)
    )
      malformed()
    const installed = search.installed
    if (installed !== null && typeof installed !== 'boolean') malformed()
    if (!request.includeInstalled && installed !== false) malformed()
    const count = search.group_occurrences
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > SKILLAGER_INVENTORY_LIMIT
    )
      malformed()
    const score = match.score
    if (typeof score !== 'number' || !Number.isFinite(score)) malformed()
    if (
      selected.kind === 'library' &&
      (row.source.ownership !== 'library' ||
        !canonical ||
        canonical.skillId !== row.id ||
        !hostPathEquals(selected.path, skillagerLibrarySkillRoot(library, row.id)))
    )
      malformed()
    if (
      selected.exposure &&
      (!canonical ||
        !local ||
        !containsHostPath(request.workspaceRoot, selected.path) ||
        hostPathEquals(request.workspaceRoot, selected.path))
    )
      malformed()
    if (
      ['library', 'source', 'project-original'].includes(selected.kind) &&
      (!hostPathEquals(selected.path, absolutePath(item.root)) ||
        !hostPathEquals(selected.entrypoint, absolutePath(item.entrypoint)))
    )
      malformed()
    const detail: SkillagerSearchIdentity = {
      groupId: identity(search.group_id),
      canonical,
      occurrence: selected,
      groupOccurrences: count,
      installed,
      match: {
        occurrence: matched,
        skillId: string(match.skill_id, 512),
        contentHash: identity(match.content_hash),
        score,
        reasons: strings(match.reasons, 32, 128).filter((reason) =>
          /^(?:id|title|name|description|summary|body|tag|tags|source|package|audience|target|targets):[a-z0-9_:-]+$/i.test(
            reason,
          ),
        ),
      },
    }
    return {
      ...row,
      search: detail,
      ...(selected.kind === 'project-original' &&
      local &&
      containsHostPath(request.workspaceRoot, selected.path)
        ? { projectSkill: { path: selected.path, agent: selected.agent, managed: false } }
        : {}),
    }
  })
  const ids = rows.map((row) =>
    request.view === 'copies' ? row.search.occurrence.id : row.search.groupId,
  )
  if (new Set(ids).size !== ids.length) malformed()
  return {
    rows,
    search: {
      scope: request.scope,
      browseAgent: request.browseAgent ?? request.agent,
      view: request.view ?? 'skills',
      includeInstalled: request.includeInstalled ?? false,
      installedObservation: observation as 'observed' | 'provided' | 'unknown',
      coverage: local ? 'local-project' : 'hvir-deliveries',
    },
  }
}

function canonicalIdentity(value: unknown, library: SkillagerLibrary) {
  if (value === null) return undefined
  const item = object(value),
    libraryId = string(item.library_id, 64),
    skillId = string(item.skill_id, 512)
  if (!UUID.test(libraryId) || libraryId !== library.id) malformed()
  try {
    skillagerLibrarySkillRoot(library, skillId)
  } catch {
    malformed()
  }
  return { libraryId, skillId }
}

function occurrence(value: unknown): SkillagerSearchOccurrence {
  const raw = object(value),
    kind = string(raw.kind, 32)
  if (
    !['library', 'source', 'project-original', 'full', 'stub', 'router-member'].includes(
      kind,
    )
  )
    malformed()
  const path = absolutePath(raw.path),
    entrypoint = absolutePath(raw.entrypoint)
  if (!containsHostPath(path, entrypoint) || hostPathEquals(path, entrypoint)) malformed()
  const agent =
    raw.agent === null
      ? undefined
      : SKILLAGER_AGENTS.find((item) => item.id === raw.agent)?.id
  if (raw.agent !== null && !agent) malformed()
  const managed = ['full', 'stub', 'router-member'].includes(kind)
  if (managed !== (raw.exposure !== undefined)) malformed()
  let exposure: SkillagerSearchOccurrence['exposure']
  if (managed) {
    const copy = object(raw.exposure)
    if (
      !agent ||
      copy.agent !== agent ||
      copy.scope !== 'project' ||
      !hostPathEquals(absolutePath(copy.target), path) ||
      copy.mode !== (kind === 'full' ? 'native' : kind === 'stub' ? 'stub' : 'router')
    )
      malformed()
    exposure = {
      id: string(copy.exposure_id, 512),
      agent,
      target: path,
      mode: copy.mode as string,
      ...(kind === 'router-member'
        ? {
            router: {
              slug: string(copy.router_slug, 512),
              kind: string(copy.router_kind, 64),
              tag: copy.tag == null ? undefined : string(copy.tag, 512),
            },
          }
        : {}),
    }
  }
  return {
    id: identity(raw.id),
    kind: kind as SkillagerSearchOccurrence['kind'],
    path,
    entrypoint,
    agent,
    sourceIdentity:
      raw.source_identity === null ? undefined : identity(raw.source_identity),
    exposure,
  }
}
function identity(value: unknown): string {
  const text = string(value, 64)
  if (!HASH.test(text)) malformed()
  return text
}
