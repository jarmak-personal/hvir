import { SKILLAGER_ACCEPTED_TRUST } from '../../shared/skillager'
import { isDeepStrictEqual } from 'node:util'
import { safeExposureId } from './skillager-exposure-selection'
import {
  basenameHostPath,
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerExposureCompletion,
  SkillagerExposurePreview,
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
  if (request.action === 'remove') return managedRemovalCommand(request)
  return [
    'expose',
    request.skillId,
    '--mode',
    request.mode,
    '--agent',
    request.agent,
    '--scope',
    'project',
    ...(request.exposure && request.destination.root.hostId === 'local'
      ? ['--exposure-id', request.exposure.id]
      : []),
    '--json',
  ]
}

export function parseExposurePreview(
  value: unknown,
  selection: SkillagerCliSelection,
  request: SkillagerExposureRequest,
): SkillagerExposureSnapshot {
  if (request.action === 'remove') {
    const { confirmationToken, ...detail } = parseManagedRemovalPreview(value, request)
    return { confirmationToken, detail: { request, ...detail } }
  }
  const row = resultRow(value, false)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== 'would_expose') return malformedExposure()
  if (!row.preview) return unsupportedExposure()
  const preview = exposureObject(row.preview)
  if (preview.schema !== 'skillager.exposure-preview.v1') return unsupportedExposure()
  const target = verifyRow(row, request)
  const targetHash =
    preview.target_state_hash === null ? null : exposureHash(preview.target_state_hash)
  const directory = exposureObject(preview.target_directory)
  const beforeMode =
    directory.before_mode === null && targetHash === null
      ? null
      : exposureMode(directory.before_mode)
  const afterMode = exposureMode(directory.after_mode)
  const effects = parseExposureEffects(preview.file_effects, false)
  if (targetHash === null && effects.some((effect) => effect.before !== null))
    return malformedExposure()
  if (
    preview.agent !== request.agent ||
    preview.mode !== request.mode ||
    preview.scope !== 'project' ||
    !hostPathEquals(absolute(preview.project), request.destination.root) ||
    !hostPathEquals(absolute(preview.target), target) ||
    (request.exposure && preview.selected_exposure_id !== request.exposure.id)
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
  if (request.action === 'update' && source.trust === 'pinned')
    return refusedExposure('pinned source')
  if (!SKILLAGER_ACCEPTED_TRUST.some((trust) => trust === String(source.trust)))
    return refusedExposure('unaccepted source')
  const sourceHash = exposureHash(source.content_hash)
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
    !hostPathEquals(absolute(metadata.source_entrypoint), joinHostPath(root, 'SKILL.md'))
  )
    return malformedExposure()
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
  if (confirmationToken !== preview.confirmation_token) return malformedExposure()
  return {
    detail: { request, target, sourceHash, targetHash, beforeMode, afterMode, effects },
    confirmationToken,
  }
}

export function parseExposureApplied(
  value: unknown,
  snapshot: SkillagerExposureSnapshot,
): SkillagerExposureCompletion {
  const request = snapshot.detail.request
  if (request.action === 'remove')
    return {
      status: 'removed',
      target: parseManagedRemovalApplied(value, request, snapshot.detail),
      skillId: request.skillId,
      mode: request.mode,
    }
  const row = resultRow(value, false)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== 'exposed') return malformedExposure()
  const target = verifyRow(row, request)
  if (!hostPathEquals(target, snapshot.detail.target)) return malformedExposure()
  return {
    status: 'exposed',
    target,
    skillId: request.skillId,
    mode: request.mode,
  }
}

export function resultRow(value: unknown, removing: boolean): Record<string, unknown> {
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
export function verifyRow(
  row: Record<string, unknown>,
  request: Pick<SkillagerExposureRequest, 'destination' | 'agent' | 'exposure'> & {
    readonly skillId?: string
    readonly mode: string
  },
): HostPath {
  if (
    (row.skill_id ?? undefined) !== request.skillId ||
    row.agent !== request.agent ||
    row.mode !== request.mode ||
    row.scope !== 'project'
  )
    return malformedExposure()
  const target = absolute(row.target)
  if (
    !containsHostPath(request.destination.root, target) ||
    hostPathEquals(request.destination.root, target) ||
    !safeExposureId(row.exposure_id) ||
    row.exposure_id !== basenameHostPath(target)
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

type ManagedRemovalSelection = Parameters<typeof verifyRow>[1]
type ManagedRemovalEffects = Pick<
  SkillagerExposurePreview,
  'targetHash' | 'beforeMode' | 'afterMode' | 'effects'
>

export function managedRemovalCommand(
  request: Pick<SkillagerExposureRequest, 'agent' | 'exposure'>,
): string[] {
  return [
    'expose',
    '--remove',
    request.exposure!.id,
    '--agent',
    request.agent,
    '--scope',
    'project',
    '--json',
  ]
}

/** One complete target-owned Remove contract, projected by direct and router actions. */
export function parseManagedRemovalPreview(
  value: unknown,
  request: ManagedRemovalSelection,
) {
  const row = resultRow(value, true)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== 'would_remove') return malformedExposure()
  const target = verifyRow(row, request)
  const effects = managedRemovalEffects(row)
  if (
    row.current_status !== 'current' ||
    row.local_changes !== false ||
    row.requires_force !== false
  )
    return refusedExposure(row.reason)
  const argv = row.next_command_argv
  const expected = [
    'skillager',
    ...managedRemovalCommand(request),
    '--yes',
    '--confirmation-token',
  ]
  if (
    !Array.isArray(argv) ||
    argv.length !== expected.length + 1 ||
    expected.some((arg, index) => argv[index] !== arg)
  )
    return malformedExposure()
  return { target, ...effects, confirmationToken: exposureHash(argv.at(-1)) }
}

export function parseManagedRemovalApplied(
  value: unknown,
  request: ManagedRemovalSelection,
  snapshot: ManagedRemovalEffects & { readonly target: HostPath },
): HostPath {
  const row = resultRow(value, true)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== 'removed') return malformedExposure()
  const target = verifyRow(row, request)
  const effects = managedRemovalEffects(row)
  if (
    !hostPathEquals(target, snapshot.target) ||
    !isDeepStrictEqual(effects, {
      targetHash: snapshot.targetHash,
      beforeMode: snapshot.beforeMode,
      afterMode: snapshot.afterMode,
      effects: snapshot.effects,
    })
  )
    return malformedExposure()
  return target
}

function managedRemovalEffects(
  row: Record<string, unknown>,
): ManagedRemovalEffects & { targetHash: string; beforeMode: number; afterMode: null } {
  if (!row.preview) return unsupportedExposure()
  const preview = exposureObject(row.preview)
  if (preview.schema !== 'skillager.exposure-remove-preview.v1')
    return unsupportedExposure()
  const directory = exposureObject(preview.target_directory)
  if (directory.after_mode !== null) return malformedExposure()
  return {
    targetHash: exposureHash(preview.target_state_hash),
    beforeMode: exposureMode(directory.before_mode),
    afterMode: null,
    effects: parseExposureEffects(preview.file_effects, true),
  }
}

/** Exact released diagnostics emitted under the resource lock before any detach. */
export function isProvenManagedRemovalRefusal(output: {
  code: number | null
  stdout: string
  stderr: string
}): boolean {
  return (
    output.code === 2 &&
    output.stdout === '' &&
    [
      'exposure removal preview is stale or does not match this command; review the current preview and execute its returned command',
      'managed exposure has local edits; preview again with --force only if those edits may be discarded',
    ].some((message) =>
      [
        message,
        `${message}\n`,
        `skillager: error: ${message}`,
        `skillager: error: ${message}\n`,
      ].includes(output.stderr),
    )
  )
}
