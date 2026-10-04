/* global TextEncoder */
import {
  absoluteLocalPath,
  digest,
  boundedManagementJson,
  MANAGEMENT_LIMITS,
  fileState,
} from './management-contract.mjs'
import { syncReviewHash, metadataEncoding } from './management-sync-review.mjs'

const schema = 'skillager.exposure-request.v1'
const actions = ['group', 'set-members', 'ungroup', 'adopt-native']
export function exposureRequest(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 6144)
    throw new Error(
      'The complete selection exceeds the action bound. Use the public CLI; no selection was truncated.',
    )
  const value = JSON.parse(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schema !== schema ||
    !actions.includes(value.action)
  )
    throw new Error(
      'Choose Group, Edit members, Ungroup or Adopt one preserved native skill',
    )
  return value
}
export function planArgs(request, agent, token) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Choose Codex or Claude')
  const args = [
    'expose',
    '--request-json',
    typeof request === 'string' ? request : JSON.stringify(request),
    '--agent',
    agent,
    '--scope',
    'project',
    '--json',
    ...(token ? ['--yes', '--confirmation-token', digest(token)] : ['--dry-run']),
  ]
  // The connector's public argv bound uses the entire JSON encoded array.
  if (new TextEncoder().encode(JSON.stringify(args)).length > 8192)
    throw new Error(
      'The complete request exceeds the connector argument bound. Use the public CLI; no plan was split or applied.',
    )
  return args
}
export function planIdentity(plan, input, workspace) {
  boundedManagementJson(plan)
  if (
    workspace?.host !== 'local' ||
    workspace.root?.hostId !== 'local' ||
    typeof workspace.id !== 'string'
  )
    throw new Error('Select the exact local project/worktree for advanced exposure')
  if (
    plan.schema !== 'skillager.exposure-plan.v1' ||
    plan.project !== workspace.root.path ||
    plan.agent !== input.agent ||
    plan.scope !== 'project' ||
    plan.library_id !== input.library.id ||
    metadataEncoding(plan.request) !== metadataEncoding(input.request)
  )
    throw new Error(
      'The complete plan differs from the selected request, library, project or agent',
    )
  if (
    !Array.isArray(plan.sources) ||
    !Array.isArray(plan.targets) ||
    !plan.targets.length ||
    plan.targets.length > 128 ||
    !plan.staging ||
    !Object.hasOwn(plan, 'group')
  )
    throw new Error(
      'Complete sources, targets, membership and staging facts are required',
    )
  const sourceIds = new Set()
  for (const source of plan.sources) {
    if (
      typeof source.id !== 'string' ||
      !/^lib\/[\w.-]+$/u.test(source.id) ||
      sourceIds.has(source.id) ||
      source.source?.library_id !== input.library.id ||
      source.source?.library_root !== input.library.root.path ||
      !absoluteLocalPath(source.root).path.startsWith(`${input.library.root.path}/`) ||
      !source.approval ||
      !source.target_state
    )
      throw new Error('Complete exact canonical source identity/version is unavailable')
    digest(source.content_hash)
    sourceIds.add(source.id)
  }
  const desired =
    input.request.action === 'adopt-native'
      ? [input.request.source?.skill_id]
      : input.request.action === 'ungroup'
        ? plan.group?.before_members
        : [
            ...(input.request.members ?? []),
            ...(input.request.departures ?? [])
              .filter((item) => item.mode !== 'remove')
              .map((item) => item.skill_id),
          ]
  if (
    !Array.isArray(desired) ||
    desired.some((id) => !sourceIds.has(id)) ||
    [...sourceIds].some((id) => !desired.includes(id))
  )
    throw new Error(
      'The plan does not cover every selected source; no grouped selection was omitted',
    )
  const targets = new Set(),
    paths = new Set()
  let count = 0
  for (const target of plan.targets) {
    digest(target.target_id)
    const path = absoluteLocalPath(target.path).path
    if (
      !path.startsWith(`${workspace.root.path}/`) ||
      paths.has(path) ||
      targets.has(target.target_id) ||
      !['parent', 'tags', 'router', 'direct', 'native-origin'].includes(target.kind) ||
      !['create', 'replace', 'remove', 'keep'].includes(target.action) ||
      !Array.isArray(target.file_effects)
    )
      throw new Error('Complete plan has invalid, repeated or outside-project targets')
    targets.add(target.target_id)
    paths.add(path)
    for (const state of [target.before, target.after])
      if (
        state !== null &&
        (!state ||
          !digest(state.state_hash) ||
          !Number.isInteger(state.mode) ||
          state.mode < 0 ||
          state.mode > 0o7777)
      )
        throw new Error('Complete target byte/mode identity is unavailable')
    const files = new Set()
    for (const effect of target.file_effects) {
      const relative = effect.path
      if (
        typeof relative !== 'string' ||
        !relative ||
        files.has(relative) ||
        (relative === '.'
          ? !['parent', 'tags'].includes(target.kind)
          : relative.startsWith('/') ||
            relative.split('/').some((p) => !p || p === '.' || p === '..')) ||
        !['create', 'replace', 'remove', 'keep'].includes(effect.action)
      )
        throw new Error('Complete file effect paths are unavailable or repeated')
      files.add(relative)
      fileState(effect.before)
      fileState(
        effect.after,
        relative === 'skillager.materialized.yaml' || target.kind === 'tags',
      )
      if (
        (effect.action === 'create' &&
          (effect.before !== null || effect.after === null)) ||
        (effect.action === 'replace' &&
          (effect.before === null || effect.after === null)) ||
        (effect.action === 'remove' && (effect.before === null || effect.after !== null))
      )
        throw new Error('File effects disagree with their before/after states')
    }
    count += target.file_effects.length
  }
  if (count > MANAGEMENT_LIMITS.effects)
    throw new Error(
      'Complete file effects exceed the review bound. Use the public CLI; no partial plan was applied.',
    )
  return plan
}
export function exposurePlan(value, input, workspace) {
  if (value?.status === 'refused')
    throw new Error(
      `${value.reason ?? 'Skillager refused this selection'}. Preserve the files, resolve this specific conflict through the public CLI or choose a fresh selection, then preview again.`,
    )
  const plan = planIdentity(value, input, workspace)
  if (plan.status !== 'would_apply')
    throw new Error('Request a complete current public preview')
  digest(plan.confirmation_token)
  planArgs(input.request, input.agent, plan.confirmation_token)
  return plan
}
export function planPayload(plan) {
  return Object.fromEntries(
    Object.entries(plan).filter(
      ([key]) =>
        ![
          'status',
          'confirmation_token',
          'next_command_argv',
          'results',
          'plan_hash',
          'reason_code',
          'reason',
        ].includes(key),
    ),
  )
}
export async function planCompletion(value, code, plan, input, workspace) {
  planIdentity(value, input, workspace)
  if (
    (await syncReviewHash(planPayload(value))) !==
      (await syncReviewHash(planPayload(plan))) ||
    value.plan_hash !== plan.confirmation_token ||
    !['applied', 'partial', 'refused'].includes(value.status) ||
    !Array.isArray(value.results) ||
    value.results.length !== plan.targets.length
  )
    throw new Error(
      'Submitted plan has no complete exact result; inspect its retained report and reconcile explicitly',
    )
  const ids = new Set()
  for (const item of value.results) {
    const target = plan.targets.find((t) => t.target_id === item.target_id)
    if (
      !target ||
      ids.has(item.target_id) ||
      item.path !== target.path ||
      !['applied', 'unchanged', 'refused', 'rolled_back', 'recovery_required'].includes(
        item.status,
      )
    )
      throw new Error('Submitted plan has ambiguous or incomplete per-target outcomes')
    ids.add(item.target_id)
    if (item.observed_state_hash !== null) digest(item.observed_state_hash)
    if (item.recovery_path !== null) absoluteLocalPath(item.recovery_path)
  }
  if (
    value.status === 'applied' &&
    (code !== 0 ||
      value.results.some(
        (item) =>
          !['applied', 'unchanged'].includes(item.status) || item.recovery_path !== null,
      ))
  )
    throw new Error('Native success disagrees with its per-target outcomes')
  if (value.status !== 'applied' && code !== 2)
    throw new Error('Native failure disagrees with its complete result')
  return value
}
