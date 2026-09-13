import type {
  SkillagerDestination,
  SkillagerExposureCompletion,
  SkillagerExposurePreview,
  SkillagerExposureRequest,
} from '../../shared/skillager-exposure'
import type { SkillagerCliSelection } from './skillager-port'
import type {
  SkillagerMetadata,
  SkillagerRequest,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'

export type SkillagerExposureObserver = (
  selection: SkillagerCliSelection,
  request: SkillagerRequest,
  source: { readonly rows: readonly SkillagerMetadata[]; readonly complete: boolean },
  signal: AbortSignal,
) => Promise<readonly SkillagerWorkspaceExposure[] | undefined>

export interface SkillagerExposureSnapshot {
  readonly detail: Omit<SkillagerExposurePreview, 'previewId'>
  readonly confirmationToken: string
  /** Releases main-only remote preparation; local CLI snapshots retain no resources. */
  dispose?(): Promise<void>
}
export interface SkillagerExposureCliPort {
  updateSourceHash(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ): Promise<string>
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
  validatePreview?(snapshot: SkillagerExposureSnapshot): void
}
export type SkillagerDestinationAvailable = (destination: SkillagerDestination) => boolean
