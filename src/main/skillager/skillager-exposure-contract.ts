import { SKILLAGER_AGENTS } from '../../shared/skillager'
import {
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerExposureCompletion,
  SkillagerExposureRequest,
} from '../../shared/skillager-exposure'
import type { SkillagerCliSelection } from './skillager-port'
import { SkillagerError } from './skillager-port'
import type { SkillagerExposureSnapshot } from './skillager-exposure-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import {
  EXPOSURE_SIDECAR,
  exposureHash,
  exposureMode,
  exposureObject,
  exposureText,
  malformedExposure,
  parseExposureEffects,
  unsupportedExposure,
} from './skillager-exposure-effects'

export function exposureCommand(request: SkillagerExposureRequest): readonly string[] {
  return [
    'expose',
    ...(request.action === 'remove'
      ? ['--remove', request.exposure!.id]
      : [request.skillId, '--mode', request.mode]),
    '--agent',
    request.agent,
    '--scope',
    'project',
    '--json',
  ]
}

export function parseExposurePreview(
  value: unknown,
  selection: SkillagerCliSelection,
  request: SkillagerExposureRequest,
): SkillagerExposureSnapshot {
  const removing = request.action === 'remove'
  const row = resultRow(value, removing)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== (removing ? 'would_remove' : 'would_expose'))
    return malformedExposure()
  if (!row.preview) return unsupportedExposure()
  const preview = exposureObject(row.preview)
  if (
    preview.schema !==
    (removing ? 'skillager.exposure-remove-preview.v1' : 'skillager.exposure-preview.v1')
  )
    return unsupportedExposure()
  const target = verifyRow(row, request)
  const targetHash =
    preview.target_state_hash === null && !removing
      ? null
      : exposureHash(preview.target_state_hash)
  const directory = exposureObject(preview.target_directory)
  const beforeMode =
    directory.before_mode === null && targetHash === null
      ? null
      : exposureMode(directory.before_mode)
  if (removing && directory.after_mode !== null) return malformedExposure()
  const afterMode = removing ? null : exposureMode(directory.after_mode)
  const effects = parseExposureEffects(preview.file_effects, removing)
  if (targetHash === null && effects.some((effect) => effect.before !== null))
    return malformedExposure()
  let sourceHash: string | undefined
  if (removing) {
    if (
      row.current_status !== 'current' ||
      row.local_changes !== false ||
      row.requires_force !== false
    )
      return refusedExposure(row.reason)
  } else {
    if (
      preview.agent !== request.agent ||
      preview.mode !== request.mode ||
      preview.scope !== 'project' ||
      !hostPathEquals(absolute(preview.project), request.destination.root) ||
      !hostPathEquals(absolute(preview.target), target)
    )
      return malformedExposure()
    const source = exposureObject(preview.source),
      provenance = exposureObject(source.source)
    const root = skillagerLibrarySkillRoot(selection.library!, request.skillId)
    if (
      source.id !== request.skillId ||
      !hostPathEquals(absolute(source.root), root) ||
      !hostPathEquals(absolute(source.entrypoint), joinHostPath(root, 'SKILL.md')) ||
      provenance.ownership !== 'library' ||
      provenance.library_id !== selection.library!.id ||
      provenance.collection !== 'lib' ||
      !hostPathEquals(absolute(provenance.library_root), selection.library!.root)
    )
      return malformedExposure()
    if (!['reviewed', 'trusted', 'pinned'].includes(String(source.trust)))
      return refusedExposure('unaccepted source')
    sourceHash = exposureHash(source.content_hash)
    const metadata = exposureObject(
      JSON.parse(
        effects.find((effect) => effect.path === EXPOSURE_SIDECAR)!.after!.metadata!,
      ),
    )
    if (
      metadata.schema !== 'skillager.materialized.v1' ||
      metadata.projection_kind !== 'direct' ||
      metadata.source_id !== request.skillId ||
      metadata.id !== request.skillId ||
      metadata.source_hash !== sourceHash ||
      metadata.source_library_id !== selection.library!.id ||
      metadata.agent !== request.agent ||
      metadata.scope !== 'project' ||
      metadata.source_type !==
        (request.mode === 'stub' ? 'skillager-stub' : provenance.type) ||
      !hostPathEquals(
        absolute(metadata.source_entrypoint),
        joinHostPath(root, 'SKILL.md'),
      )
    )
      return malformedExposure()
  }
  const argv = row.next_command_argv
  if (!Array.isArray(argv)) return malformedExposure()
  const expected = [
    'skillager',
    ...exposureCommand(request),
    '--yes',
    '--confirmation-token',
  ]
  if (
    argv.length !== expected.length + 1 ||
    expected.some((arg, index) => argv[index] !== arg)
  )
    return malformedExposure()
  const confirmationToken = exposureHash(argv.at(-1))
  if (!removing && confirmationToken !== preview.confirmation_token)
    return malformedExposure()
  return {
    detail: { request, target, sourceHash, targetHash, beforeMode, afterMode, effects },
    confirmationToken,
  }
}

export function parseExposureApplied(
  value: unknown,
  snapshot: SkillagerExposureSnapshot,
): SkillagerExposureCompletion {
  const request = snapshot.detail.request,
    removing = request.action === 'remove'
  const row = resultRow(value, removing)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== (removing ? 'removed' : 'exposed')) return malformedExposure()
  const target = verifyRow(row, request)
  if (!hostPathEquals(target, snapshot.detail.target)) return malformedExposure()
  if (removing) {
    const preview = exposureObject(row.preview)
    if (
      preview.schema !== 'skillager.exposure-remove-preview.v1' ||
      preview.target_state_hash !== snapshot.detail.targetHash ||
      exposureObject(preview.target_directory).before_mode !==
        snapshot.detail.beforeMode ||
      exposureObject(preview.target_directory).after_mode !== null ||
      JSON.stringify(parseExposureEffects(preview.file_effects, true)) !==
        JSON.stringify(snapshot.detail.effects)
    )
      return malformedExposure()
  }
  return {
    status: removing ? 'removed' : 'exposed',
    target,
    skillId: request.skillId,
    mode: request.mode,
  }
}

function resultRow(value: unknown, removing: boolean): Record<string, unknown> {
  let rows: unknown = value
  if (removing) {
    const data = exposureObject(value)
    if (data.schema !== 'skillager.exposure-remove.v1') return unsupportedExposure()
    rows = data.results
  }
  if (!Array.isArray(rows) || rows.length !== 1) return malformedExposure()
  const row = exposureObject(rows[0])
  if (
    row.schema !== (removing ? 'skillager.exposure.v1' : 'skillager.exposure-result.v1')
  )
    return unsupportedExposure()
  return row
}
function verifyRow(
  row: Record<string, unknown>,
  request: SkillagerExposureRequest,
): HostPath {
  if (
    row.skill_id !== request.skillId ||
    row.agent !== request.agent ||
    row.mode !== request.mode ||
    row.scope !== 'project'
  )
    return malformedExposure()
  const target = absolute(row.target),
    parent = dirnameHostPath(target)
  const roots = SKILLAGER_AGENTS.find(
    (agent) => agent.id === request.agent,
  )!.projectSkillRoots
  if (
    !roots.some((root) =>
      hostPathEquals(parent, joinHostPath(request.destination.root, ...root.split('/'))),
    ) ||
    exposureText(row.exposure_id, 512) !== target.path.split('/').at(-1)
  )
    throw new SkillagerError(
      'unavailable',
      'Skillager resolved a different destination. This action is unavailable for the selected workspace.',
    )
  if (
    request.exposure &&
    (row.exposure_id !== request.exposure.id ||
      !hostPathEquals(target, request.exposure.target))
  )
    throw new SkillagerError(
      'stale-review',
      'The selected workspace copy changed. Refresh and preview it again.',
    )
  return target
}
function absolute(value: unknown): HostPath {
  const text = exposureText(value),
    path = localPath(text)
  if (!text.startsWith('/') || path.path !== text) return malformedExposure()
  return path
}
export function refusedExposure(reason: unknown): never {
  const text = typeof reason === 'string' ? reason : ''
  if (/stale|changed during|changed;|approval changed|source changed/.test(text))
    throw new SkillagerError(
      'stale-review',
      'The source or target changed. Refresh and review a new preview; this confirmation cannot be retried.',
    )
  const detail = /pinned/.test(text)
    ? 'The source version is pinned.'
    : /blocked|pending|unaccepted|not selectable|not available/.test(text)
      ? 'The source is not accepted and available for this action.'
      : /incompatib|exclusive to/.test(text)
        ? 'The skill is incompatible with this agent.'
        : /local edit|unmanaged|customiz/.test(text)
          ? 'The workspace target contains local changes or is unmanaged.'
          : 'Skillager refused this action. Check the source and workspace state.'
  throw new SkillagerError(
    'review-refused',
    `${detail} Hvir does not force replacement or change approval policy.`,
  )
}
