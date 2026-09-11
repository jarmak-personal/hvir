import { hostPathEquals, localPath } from '../../shared/host-path'
import {
  SKILLAGER_INVENTORY_LIMIT,
  type SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import type { SkillagerExposureSnapshot } from './skillager-exposure-port'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import { reviewObject, reviewHash, reviewText } from './skillager-review-contract'

/** Canonical source versions come from public library status, never a Stub body hash. */
export function parseUpdateSourceHash(
  value: unknown,
  selection: SkillagerCliSelection,
  snapshot: SkillagerExposureSnapshot,
  exposures: readonly SkillagerWorkspaceExposure[],
): string {
  const { request, sourceHash, target, targetHash } = snapshot.detail
  const selected = request.exposure
  const observed = exposures.filter(
    (copy) =>
      copy.id === selected?.id &&
      copy.skillId === request.skillId &&
      copy.mode === request.mode &&
      hostPathEquals(copy.target, target),
  )
  if (
    observed.length !== 1 ||
    observed[0]!.status !== 'source_update' ||
    observed[0]!.expectedSourceHash !== sourceHash ||
    !targetHash
  )
    throw new SkillagerError(
      'stale-review',
      'This workspace copy is no longer an eligible update. Refresh its state.',
    )
  const data = reviewObject(value),
    skill = reviewObject(data.skill)
  if (
    data.schema !== 'skillager.library-status.v1' ||
    skill.id !== request.skillId ||
    !hostPathEquals(
      localPath(reviewText(skill.path, 16384)),
      skillagerLibrarySkillRoot(selection.library!, request.skillId),
    )
  )
    throw new SkillagerError(
      'malformed-result',
      'Skillager returned unsupported update status.',
    )
  if (
    skill.acceptance !== 'accepted' ||
    reviewHash(skill.accepted_hash) !== sourceHash ||
    reviewHash(skill.working_hash) !== sourceHash
  )
    throw new SkillagerError(
      'stale-review',
      'The accepted source changed or is unavailable. Refresh and review again.',
    )
  if (
    !Array.isArray(skill.exposures) ||
    skill.exposures.length > SKILLAGER_INVENTORY_LIMIT
  )
    throw new SkillagerError(
      'malformed-result',
      'Skillager returned unsupported exposure versions.',
    )
  const matches = skill.exposures
    .map(reviewObject)
    .filter(
      (copy) =>
        copy.agent === request.agent &&
        copy.scope === 'project' &&
        copy.kind === request.mode &&
        hostPathEquals(localPath(reviewText(copy.path, 16384)), target),
    )
  if (matches.length !== 1 || matches[0]!.status !== 'update_available')
    throw new SkillagerError(
      'stale-review',
      'The exact workspace source version is unavailable. Refresh and review again.',
    )
  const from = reviewHash(matches[0]!.source_hash)
  if (from === sourceHash)
    throw new SkillagerError(
      'stale-review',
      'This workspace copy no longer needs this update.',
    )
  return from
}
