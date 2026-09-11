import type {
  SkillagerDestination,
  SkillagerExposureCompletion,
  SkillagerExposurePreview,
  SkillagerExposureRequest,
} from '../../shared/skillager-exposure'
import type { SkillagerCliSelection } from './skillager-port'

export interface SkillagerExposureSnapshot {
  readonly detail: Omit<SkillagerExposurePreview, 'previewId'>
  readonly confirmationToken: string
}
export interface SkillagerExposureCliPort {
  previewExposure(
    selection: SkillagerCliSelection,
    request: SkillagerExposureRequest,
    signal: AbortSignal,
  ): Promise<SkillagerExposureSnapshot>
  applyExposure(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ): Promise<SkillagerExposureCompletion>
}
export interface SkillagerExposureGrant {
  readonly selection: SkillagerCliSelection
  assertCurrent(): void
}
export type SkillagerDestinationAvailable = (destination: SkillagerDestination) => boolean
