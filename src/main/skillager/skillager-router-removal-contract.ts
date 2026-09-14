import type {
  SkillagerRouterRemovalCompletion,
  SkillagerRouterRemovalPreview,
  SkillagerRouterRemovalRequest,
} from '../../shared/skillager-exposure-plan'
import {
  parseManagedRemovalApplied,
  parseManagedRemovalPreview,
} from './skillager-exposure-contract'
export { managedRemovalCommand as routerRemovalCommand } from './skillager-exposure-contract'

export interface SkillagerRouterRemovalSnapshot {
  readonly detail: Omit<SkillagerRouterRemovalPreview, 'previewId'>
  readonly confirmationToken: string
  readonly targetHash: string
}
/** Router presentation of the existing target-owned managed Remove contract. */
export function parseRouterRemoval(
  raw: unknown,
  request: SkillagerRouterRemovalRequest,
  applied?: SkillagerRouterRemovalSnapshot,
): SkillagerRouterRemovalSnapshot | SkillagerRouterRemovalCompletion {
  const selection = { ...request, mode: 'router', skillId: request.exposure.skillId }
  if (applied)
    return {
      kind: 'remove-router',
      status: 'removed',
      target: parseManagedRemovalApplied(raw, selection, {
        ...applied.detail,
        targetHash: applied.targetHash,
        afterMode: null,
      }),
    }
  const { target, beforeMode, effects, confirmationToken, targetHash } =
    parseManagedRemovalPreview(raw, selection)
  return {
    detail: { kind: 'remove-router', request, target, beforeMode, effects },
    confirmationToken,
    targetHash,
  }
}
