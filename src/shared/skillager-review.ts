import type { HostPath } from './host-path'
import type { SkillagerRequest } from './skillager'

export interface SkillagerSkillRequest extends SkillagerRequest {
  readonly skillId: string
}
export interface SkillagerReviewRequest extends SkillagerRequest {
  readonly reviewId: string
}
export interface SkillagerReviewFile {
  readonly entry: string
  readonly size: number
  readonly executable: boolean
}
export interface SkillagerHistory {
  readonly available: boolean
  readonly reason?: string
  readonly versions: readonly {
    readonly hash: string
    readonly committedAt: string
    readonly accepted: boolean
    readonly current: boolean
  }[]
}
export interface SkillagerReview {
  readonly reviewId: string
  readonly skillId: string
  readonly root: HostPath
  readonly hash: string
  readonly files: readonly SkillagerReviewFile[]
  readonly canAccept: boolean
  readonly refusal?: string
  readonly scanRisk: string
  readonly lintStatus: string
  readonly findings: readonly string[]
  readonly history: SkillagerHistory
}
export interface SkillagerReviewContent {
  readonly entry: string
  readonly path: HostPath
  readonly size: number
  readonly text?: string
  readonly image?: { readonly mime: string; readonly bytes: Uint8Array }
  readonly htmlUrl?: string
}
export interface SkillagerReviewDiff {
  readonly fromHash?: string
  readonly toHash: string
  readonly text: string
}
export interface SkillagerAcceptance {
  readonly hash: string
  readonly status: 'accepted'
}

// Retained review trees are complete or refused, never silently truncated.
export const SKILLAGER_REVIEW_MAX_BYTES = 32 * 1024 * 1024
export const SKILLAGER_REVIEW_FILE_BYTES = 8 * 1024 * 1024
export const SKILLAGER_REVIEW_MAX_FILES = 512
