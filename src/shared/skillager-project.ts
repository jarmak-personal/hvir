import type { HostPath } from './host-path'
import type { HarnessProfile } from './harness-profile'
import type { SkillagerWorkspaceExposure } from './skillager'
import type { SkillagerAgent, SkillagerMetadata } from './skillager'

export type SkillagerWorkingStatus =
  'missing' | 'present' | 'unmanaged' | 'drift' | 'stale'

export interface SkillagerProjectStatus {
  readonly projectRoot: HostPath
  readonly agent: SkillagerAgent
  readonly status: string
  readonly canProceed: boolean
  readonly reviewNeeded: number
  readonly lintBlocked: number
  readonly working: SkillagerWorkingStatus
}

export interface SkillagerProjectMetadata {
  readonly rows: readonly SkillagerMetadata[]
  readonly status: SkillagerProjectStatus
}

export interface SkillagerProjectObservation extends SkillagerProjectMetadata {
  readonly setupRunning: boolean
  readonly exposures?: readonly SkillagerWorkspaceExposure[]
  readonly checkedAt: number
  readonly durationMs: number
}

/** Presentation of a main-retained, one-use setup launch; no command input authority. */
export interface SkillagerProjectSetup {
  readonly setupId: string
  readonly sessionId: string
  readonly projectRoot: HostPath
  readonly agent: SkillagerAgent
  readonly executable: HostPath
  readonly profile: HarnessProfile
}

export interface SkillagerProjectStart {
  readonly setupId: string
  readonly cols: number
  readonly rows: number
  readonly position: number
}
