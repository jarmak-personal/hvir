import type { HostPath } from '../../shared/host-path'
import type {
  SkillagerAcceptance,
  SkillagerHistory,
  SkillagerReview,
  SkillagerReviewDiff,
} from '../../shared/skillager-review'
import type { SkillagerCliSelection } from './skillager-port'

/** Retained bytes and CLI confirmation material never enter metadata inventories. */
export interface SkillagerReviewSnapshot {
  readonly detail: Omit<SkillagerReview, 'reviewId'>
  readonly bytes: ReadonlyMap<string, Uint8Array>
  readonly confirmationToken?: string
  dispose(): Promise<void>
}
export interface SkillagerReviewCliPort {
  review(
    selection: SkillagerCliSelection,
    skillId: string,
    signal: AbortSignal,
  ): Promise<SkillagerReviewSnapshot>
  history(
    selection: SkillagerCliSelection,
    skillId: string,
    signal: AbortSignal,
  ): Promise<SkillagerHistory>
  diff(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    fromHash: string | undefined,
    signal: AbortSignal,
  ): Promise<SkillagerReviewDiff>
  accept(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    signal: AbortSignal,
  ): Promise<SkillagerAcceptance>
}
export interface SkillagerReviewPreviewPort {
  create(content: string, root: HostPath): { readonly id: string; readonly url: string }
  release(id: string): void
}
