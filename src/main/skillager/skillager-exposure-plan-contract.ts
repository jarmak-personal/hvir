import { isDeepStrictEqual } from 'node:util'
import {
  basenameHostPath,
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerLifecycleRequest,
  SkillagerPlanCompletion,
  SkillagerPlanPreview,
  SkillagerPlanTarget,
} from '../../shared/skillager-exposure-plan'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import {
  entry,
  exposureHash,
  exposureMode,
  exposureObject as object,
  exposureText,
  inertMetadata,
  malformedExposure as malformed,
  unsupportedExposure,
} from './skillager-exposure-effects'
import { safeExposureId } from './skillager-exposure-selection'

export interface SkillagerPlanSnapshot {
  readonly detail: Omit<SkillagerPlanPreview, 'previewId'>
  readonly confirmationToken: string
  readonly payload: Readonly<Record<string, unknown>>
}
const PAYLOAD_KEYS = [
  'schema',
  'request',
  'project',
  'agent',
  'scope',
  'library_id',
  'sources',
  'group',
  'staging',
  'targets',
] as const

export function planCommand(request: SkillagerLifecycleRequest): string[] {
  return [
    'expose',
    '--request-json',
    JSON.stringify(request.plan),
    '--agent',
    request.agent,
    '--scope',
    'project',
    '--json',
  ]
}

export function parsePlanPreview(
  raw: unknown,
  code: number | null,
  selection: SkillagerCliSelection,
  request: SkillagerLifecycleRequest,
): SkillagerPlanSnapshot {
  const data = object(raw)
  requireSchema(data)
  refuse(data, code)
  if (code !== 0 || data.status !== 'would_apply') return malformed()
  if (
    !isDeepStrictEqual(data.request, request.plan) ||
    data.project !== request.destination.root.path ||
    data.agent !== request.agent ||
    data.scope !== 'project' ||
    data.library_id !== selection.library?.id
  )
    return malformed()
  const targets = array(data.targets, 128).map((value) =>
    target(value, request.destination.root),
  )
  if (
    !targets.length ||
    targets.reduce((sum, target) => sum + target.effects.length, 0) > 2048
  )
    return malformed()
  unique(targets.map((target) => target.id))
  unique(targets.map((target) => target.path.path))
  const sources = array(data.sources, 64)
  const ids = sources.map((value) => {
    const source = object(value),
      provenance = object(source.source)
    const id = exposureText(source.id, 68),
      root = skillagerLibrarySkillRoot(selection.library!, id)
    if (
      provenance.library_id !== selection.library!.id ||
      provenance.ownership !== 'library' ||
      source.root !== root.path ||
      source.entrypoint !== joinHostPath(root, 'SKILL.md').path ||
      !['reviewed', 'trusted', 'pinned'].includes(String(source.trust))
    )
      return malformed()
    const hash = exposureHash(source.content_hash),
      approval = object(source.approval)
    exposureHash(approval.evidence_id)
    exposureText(approval.decision_skill_id, 512)
    if (
      approval.content_hash !== hash ||
      !['reviewed', 'trusted', 'pinned'].includes(String(approval.state)) ||
      !['project', 'global'].includes(String(approval.scope)) ||
      typeof approval.lint_override !== 'boolean' ||
      typeof approval.risk_override !== 'boolean'
    )
      return malformed()
    const observed = object(source.target_state)
    exposureHash(observed.tree)
    exposureMode(observed.mode)
    return id
  })
  unique(ids)
  for (const selected of request.origins) {
    const matching = sources
      .flatMap((value) => array(object(value).lineages, 128))
      .filter((value) => object(object(value).origin).origin_id === selected.originId)
    if (matching.length !== 1) return malformed()
    const lineage = object(matching[0]),
      origin = object(lineage.origin),
      native = object(origin.native),
      canonical = object(lineage.canonical)
    if (
      lineage.lineage_id !== selected.lineageId ||
      lineage.source_identity !== selected.sourceIdentity ||
      lineage.preservation !== 'verified' ||
      origin.path !== selected.path.path ||
      native.project_root !== request.destination.root.path ||
      native.agent !== request.agent ||
      native.scope !== 'project' ||
      object(origin.observation).status !== 'current' ||
      canonical.library_id !== selection.library!.id ||
      canonical.skill_id !== selected.skillId
    )
      return malformed()
    if (!targets.some((target) => hostPathEquals(target.path, selected.path)))
      return malformed()
  }
  for (const selected of request.exposures) {
    if (
      !targets.some(
        (target) =>
          target.exposureId === selected.id &&
          hostPathEquals(target.path, selected.target),
      )
    )
      return malformed()
  }
  validateSelectionEffects(request, targets, ids)
  validateMetadataEffects(targets, request, selection)
  const staging = object(data.staging)
  const sizes = [
    'candidate_bytes',
    'retained_original_bytes',
    'transfer_reserve_bytes',
    'peak_bytes',
    'limit_bytes',
  ].map((key) => natural(staging[key]))
  if (
    sizes[0]! + sizes[1]! + sizes[2]! !== sizes[3] ||
    sizes[3] > 128 * 1024 * 1024 ||
    sizes[4] !== 128 * 1024 * 1024
  )
    return malformed()
  const group = data.group === null ? null : inertMetadata(object(data.group))
  validateGroup(request, data.group)
  const confirmationToken = exposureHash(data.confirmation_token)
  const expected = [
    'skillager',
    ...planCommand(request),
    '--yes',
    '--confirmation-token',
    confirmationToken,
  ]
  // The CLI canonically serializes the request; argv is verified, never executed.
  const command = array(data.next_command_argv, 20).map((value) =>
    exposureText(value, 65536),
  )
  if (
    command.length !== expected.length ||
    command.some((part, index) => index !== 3 && part !== expected[index])
  )
    return malformed()
  try {
    if (!isDeepStrictEqual(JSON.parse(command[3]!), request.plan)) return malformed()
  } catch {
    return malformed()
  }
  return {
    detail: {
      kind: 'plan',
      request,
      targets,
      sources: sources.map((value) => inertMetadata(object(value))),
      group,
      staging: inertMetadata(staging),
    },
    confirmationToken,
    payload: Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, data[key]])),
  }
}

export function parsePlanApplied(
  raw: unknown,
  code: number | null,
  snapshot: SkillagerPlanSnapshot,
): SkillagerPlanCompletion {
  const data = object(raw)
  requireSchema(data)
  refuse(data, code)
  if (
    !['applied', 'partial'].includes(String(data.status)) ||
    code !== (data.status === 'applied' ? 0 : 2) ||
    data.plan_hash !== snapshot.confirmationToken ||
    PAYLOAD_KEYS.some((key) => !isDeepStrictEqual(data[key], snapshot.payload[key]))
  )
    return malformed()
  const results = array(data.results, 128)
  if (results.length !== snapshot.detail.targets.length) return malformed()
  const byId = new Map(snapshot.detail.targets.map((target) => [target.id, target]))
  const targets = results.map((value) => {
    const item = object(value),
      id = exposureHash(item.target_id),
      target = byId.get(id)
    if (
      !target ||
      item.path !== target.path.path ||
      item.action !== target.action ||
      item.kind !== target.kind
    )
      return malformed()
    byId.delete(id)
    const status = choice(item.status, [
      'applied',
      'unchanged',
      'refused',
      'rolled_back',
      'recovery_required',
    ] as const)
    const observedHash =
      item.observed_state_hash === null ? null : exposureHash(item.observed_state_hash)
    if (
      data.status === 'applied' &&
      (!['applied', 'unchanged'].includes(status) || item.recovery_path != null)
    )
      return malformed()
    if (status === 'applied' && (target.after === null) !== (observedHash === null))
      return malformed()
    if (status === 'unchanged' && observedHash !== (target.before?.hash ?? null))
      return malformed()
    if (status === 'rolled_back' && observedHash !== (target.before?.hash ?? null))
      return malformed()
    return {
      id,
      path: target.path,
      status,
      observedHash,
      reason: reason(item.reason_code),
      recoveryPath:
        item.recovery_path == null
          ? undefined
          : confined(item.recovery_path, snapshot.detail.request.destination.root),
    }
  })
  return {
    kind: 'plan',
    status: data.status as 'applied' | 'partial',
    reason: reason(data.reason_code),
    targets,
  }
}

function target(raw: unknown, root: HostPath): SkillagerPlanTarget {
  const data = object(raw),
    kind = choice(data.kind, [
      'parent',
      'tags',
      'direct',
      'router',
      'native-origin',
    ] as const)
  const path = confined(data.path, root),
    before = state(data.before),
    after = state(data.after)
  const action = choice(data.action, ['create', 'replace', 'remove', 'keep'] as const)
  if (
    (!before && !after) ||
    (action === 'create' && before) ||
    (action === 'remove' && after) ||
    (action === 'replace' && (!before || !after)) ||
    (action === 'keep' && !isDeepStrictEqual(before, after))
  )
    return malformed()
  const effects = array(data.file_effects, 2048).map((value) => {
    const effect = object(value),
      relative = exposureText(effect.path, 4096)
    if (kind === 'parent' || kind === 'tags') {
      if (relative !== '.') return malformed()
    } else if (
      relative.includes('\\') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return malformed()
    const old = effect.before === null ? null : entry(effect.before, false)
    const next =
      effect.after === null
        ? null
        : entry(
            effect.after,
            kind === 'tags' || relative === 'skillager.materialized.yaml'
              ? 'plan'
              : false,
          )
    if (
      old?.type === 'symlink' ||
      old?.type === 'special' ||
      next?.type === 'symlink' ||
      next?.type === 'special'
    )
      return malformed()
    const action: SkillagerPlanTarget['action'] =
      old === null
        ? 'create'
        : next === null
          ? 'remove'
          : isDeepStrictEqual(effect.before, effect.after)
            ? 'keep'
            : 'replace'
    if (
      (!old && !next) ||
      effect.action !== action ||
      (!before && old) ||
      (!after && next)
    )
      return malformed()
    return { path: relative, action, before: old, after: next }
  })
  unique(effects.map((effect) => effect.path))
  const entries = new Map(effects.map((effect) => [effect.path, effect]))
  for (const effect of effects)
    for (const side of ['before', 'after'] as const) {
      const parts = effect.path.split('/')
      for (let i = 1; i < parts.length; i++)
        if (
          effect[side] &&
          entries.get(parts.slice(0, i).join('/'))?.[side]?.type !== 'directory'
        )
          return malformed()
    }
  if (kind === 'parent' || kind === 'tags') {
    if (effects.length !== 1) return malformed()
    for (const side of ['before', 'after'] as const)
      if (
        effects[0]![side] &&
        effects[0]![side].type !== (kind === 'parent' ? 'directory' : 'file')
      )
        return malformed()
    if (
      effects[0]!.before?.mode !== before?.mode ||
      effects[0]!.after?.mode !== after?.mode
    )
      return malformed()
  } else {
    for (const side of ['before', 'after'] as const)
      if (
        (side === 'before' ? before : after) &&
        entries.get('SKILL.md')?.[side]?.type !== 'file'
      )
        return malformed()
    if (
      after &&
      kind !== 'native-origin' &&
      !entries.get('skillager.materialized.yaml')?.after
    )
      return malformed()
  }
  if (
    data.exposure_id !== undefined &&
    (!safeExposureId(data.exposure_id) || data.exposure_id !== basenameHostPath(path))
  )
    return malformed()
  return {
    id: exposureHash(data.target_id),
    path,
    kind,
    action,
    before,
    after,
    effects,
    exposureId: optionalText(data.exposure_id),
    skillId: optionalText(data.skill_id),
    originId: optionalText(data.origin_id),
  }
}

function validateMetadataEffects(
  targets: readonly SkillagerPlanTarget[],
  request: SkillagerLifecycleRequest,
  selection: SkillagerCliSelection,
): void {
  for (const target of targets) {
    if (!target.after || target.kind === 'parent' || target.action === 'keep') continue
    const file = target.effects.find(
      (effect) =>
        effect.path === (target.kind === 'tags' ? '.' : 'skillager.materialized.yaml'),
    )?.after
    if (!file?.metadata || !file.generatedFields?.length) return malformed()
    const metadata = object(JSON.parse(file.metadata))
    if (target.kind === 'tags') {
      object(metadata.tags)
      continue
    }
    for (const key of [
      'materialized_at',
      'materialized_fingerprint',
      'materialized_sidecar_hash',
    ])
      if (!file.generatedFields.some((field) => field.startsWith(`${key}:`)))
        return unsupportedExposure()
    if (metadata.agent !== request.agent || metadata.scope !== 'project')
      return malformed()
    if (target.kind === 'direct') {
      if (
        metadata.schema !== 'skillager.materialized.v1' ||
        metadata.projection_kind !== 'direct' ||
        metadata.id !== target.skillId ||
        metadata.source_id !== target.skillId ||
        metadata.source_library_id !== selection.library!.id
      )
        return malformed()
    } else if (target.kind === 'router') {
      if (
        metadata.schema !== 'skillager.router.v1' ||
        metadata.router_slug !== target.exposureId
      )
        return malformed()
      const ids = array(metadata.skill_ids, 64).map((id) => exposureText(id, 68))
      const members = array(metadata.member_sources, 64)
      unique(ids)
      if (ids.length !== members.length) return malformed()
      const known = new Set(ids)
      for (const value of members) {
        const member = object(value),
          id = exposureText(member.skill_id, 68)
        if (!known.delete(id) || member.source_library_id !== selection.library!.id)
          return malformed()
      }
      const plan = request.plan
      if (
        (plan.action !== 'group' && plan.action !== 'set-members') ||
        !isDeepStrictEqual([...ids].sort(), [...plan.members].sort())
      )
        return malformed()
    }
  }
}

function validateSelectionEffects(
  request: SkillagerLifecycleRequest,
  targets: readonly SkillagerPlanTarget[],
  ids: readonly string[],
): void {
  const plan = request.plan
  if (plan.action === 'adopt-native' || plan.action === 'remove-native') {
    const origin = request.origins.find((item) => item.originId === plan.origin_id)
    if (
      !origin ||
      targets.filter((target) => target.kind !== 'parent').length !== 1 ||
      !ids.includes(plan.source.skill_id)
    )
      return malformed()
    const target = targets.find((target) => hostPathEquals(target.path, origin.path))
    if (
      !target ||
      (plan.action === 'remove-native'
        ? target.action !== 'remove' || target.originId !== plan.origin_id
        : !target.after || target.skillId !== plan.source.skill_id)
    )
      return malformed()
  }
  if (plan.action === 'group' || plan.action === 'set-members')
    for (const id of plan.members) if (!ids.includes(id)) return malformed()
}
function validateGroup(request: SkillagerLifecycleRequest, value: unknown): void {
  const plan = request.plan
  if (plan.action === 'adopt-native' || plan.action === 'remove-native') {
    if (value !== null) return malformed()
    return
  }
  const group = object(value)
  if (group.tag !== '' || plan.action !== 'ungroup') exposureText(group.tag, 128)
  const before = array(group.before_members, 64).map((value) => exposureText(value, 68))
  const after = array(group.after_members, 64).map((value) => exposureText(value, 68))
  unique(before)
  unique(after)
  for (const name of ['before_tag_members', 'after_tag_members'])
    unique(array(group[name], 5000).map((value) => exposureText(value, 512)))
  if (
    group.tag_policy !==
    (plan.action === 'group'
      ? 'create'
      : plan.action === 'ungroup'
        ? 'retained'
        : 'update')
  )
    return malformed()
  if (
    plan.action === 'ungroup'
      ? after.length
      : !isDeepStrictEqual([...after].sort(), [...plan.members].sort())
  )
    return malformed()
  if (plan.action !== 'group') {
    const selected = request.exposures.find((item) => item.id === plan.router_id)
    if (
      !selected?.router ||
      !isDeepStrictEqual([...before].sort(), [...selected.router.skillIds].sort())
    )
      return malformed()
  }
}
function requireSchema(data: Record<string, unknown>): void {
  if (data.schema !== 'skillager.exposure-plan.v1') unsupportedExposure()
}
function refuse(data: Record<string, unknown>, code: number | null): void {
  if (data.status !== 'refused') return
  if (
    code !== 2 ||
    array(data.results, 128).some((value) => object(value).status !== 'refused')
  )
    return malformed()
  throw new SkillagerError(
    'review-refused',
    `Skillager refused this action: ${reason(data.reason_code) ?? 'unavailable'}. ${typeof data.reason === 'string' ? data.reason.slice(0, 32768) : 'Request a fresh preview after resolving the reported state.'}`,
  )
}
function state(value: unknown) {
  if (value === null) return null
  const data = object(value)
  return { hash: exposureHash(data.state_hash), mode: exposureMode(data.mode) }
}
function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : exposureText(value, 512)
}
function reason(value: unknown): string | undefined {
  if (value == null) return undefined
  const result = exposureText(value, 128)
  if (!/^[a-z][a-z0-9-]*$/.test(result)) return malformed()
  return result
}
function natural(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return malformed()
  return Number(value)
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) malformed()
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return malformed()
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) return malformed()
  return value as T
}
export function confined(value: unknown, root: HostPath): HostPath {
  const text = exposureText(value)
  const path = localPath(text)
  if (
    !text.startsWith('/') ||
    text !== path.path ||
    root.hostId !== 'local' ||
    !containsHostPath(root, path) ||
    hostPathEquals(root, path)
  )
    return malformed()
  return path
}
