import type { HostPath } from './host-path'
import type { SkillagerAgent, SkillagerRequest } from './skillager'
import type { SkillagerReviewContent } from './skillager-review'

/** Explicit current-file selection, never an approval snapshot or search match. */
export interface SkillagerContentSelection {
  readonly kind: 'library' | 'project-original' | 'full' | 'stub' | 'router'
  readonly skillId: string
  readonly libraryId?: string
  readonly root: HostPath
  readonly path: HostPath
  readonly agent?: SkillagerAgent
  /** Only an accepted selected source; never an installed copy or another match. */
  readonly expectedHash?: string
}
export interface SkillagerContentRequest extends SkillagerRequest {
  readonly selection: SkillagerContentSelection
}
export interface SkillagerContentSession {
  readonly contentId: string
  readonly selection: SkillagerContentSelection
  readonly content: SkillagerReviewContent
}
export interface SkillagerContentFileRequest extends SkillagerRequest {
  readonly contentId: string
  readonly entry: string
  readonly documentEntry?: string
}
