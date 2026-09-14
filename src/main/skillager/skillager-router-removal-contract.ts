import { isDeepStrictEqual } from 'node:util'
import type {
  SkillagerRouterRemovalCompletion,
  SkillagerRouterRemovalPreview,
  SkillagerRouterRemovalRequest,
} from '../../shared/skillager-exposure-plan'
import {
  exposureHash,
  exposureMode,
  exposureObject,
  malformedExposure,
  parseExposureEffects,
  unsupportedExposure,
} from './skillager-exposure-effects'
import { resultRow, refusedExposure, verifyRow } from './skillager-exposure-contract'

export interface SkillagerRouterRemovalSnapshot {
  readonly detail: Omit<SkillagerRouterRemovalPreview, 'previewId'>
  readonly confirmationToken: string
  readonly preview: unknown
}
export function routerRemovalCommand(request: SkillagerRouterRemovalRequest): string[] {
  return [
    'expose',
    '--remove',
    request.exposure.id,
    '--agent',
    request.agent,
    '--scope',
    'project',
    '--json',
  ]
}
/** Target-owned existing Remove contract; canonical/member approval is never consulted. */
export function parseRouterRemoval(
  raw: unknown,
  request: SkillagerRouterRemovalRequest,
  applied?: SkillagerRouterRemovalSnapshot,
): SkillagerRouterRemovalSnapshot | SkillagerRouterRemovalCompletion {
  const row = resultRow(raw, true)
  if (row.status === 'skipped' || row.requires_force === true)
    return refusedExposure(row.reason)
  if (row.status !== (applied ? 'removed' : 'would_remove')) return malformedExposure()
  const target = verifyRow(row, {
    ...request,
    mode: 'router',
    skillId: request.exposure.skillId,
  })
  const preview = exposureObject(row.preview)
  if (preview.schema !== 'skillager.exposure-remove-preview.v1')
    return unsupportedExposure()
  exposureHash(preview.target_state_hash)
  const directory = exposureObject(preview.target_directory),
    beforeMode = exposureMode(directory.before_mode)
  if (directory.after_mode !== null) return malformedExposure()
  const effects = parseExposureEffects(preview.file_effects, true)
  if (applied) {
    if (!isDeepStrictEqual(preview, applied.preview)) return malformedExposure()
    return { kind: 'remove-router', status: 'removed', target }
  }
  if (
    row.current_status !== 'current' ||
    row.local_changes !== false ||
    row.requires_force !== false
  )
    return refusedExposure(row.reason)
  const argv = row.next_command_argv
  const expected = [
    'skillager',
    ...routerRemovalCommand(request),
    '--yes',
    '--confirmation-token',
  ]
  if (
    !Array.isArray(argv) ||
    argv.length !== expected.length + 1 ||
    expected.some((value, index) => argv[index] !== value)
  )
    return malformedExposure()
  return {
    detail: { kind: 'remove-router', request, target, beforeMode, effects },
    preview,
    confirmationToken: exposureHash(argv.at(-1)),
  }
}
