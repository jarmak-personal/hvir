import type { HostPath } from './host-path'
import type { SkillagerRequest, SkillagerWorkspaceExposure } from './skillager'

export type SkillagerExposureMode = 'native' | 'stub'
export interface SkillagerDestination {
  readonly projectId: string
  readonly workspaceId: string
  readonly root: HostPath
}
export interface SkillagerExposureRequest extends SkillagerRequest {
  readonly destination: SkillagerDestination
  readonly skillId: string
  readonly mode: SkillagerExposureMode
  readonly action: 'add' | 'change' | 'remove'
  readonly exposure?: SkillagerWorkspaceExposure
}
export interface SkillagerExposureEntry {
  readonly type: 'file' | 'directory' | 'symlink' | 'special'
  readonly mode: number
  readonly size?: number
  readonly sha256?: string
  readonly linkTarget?: string
  readonly device?: number
  readonly metadata?: string
  readonly generatedFields?: readonly string[]
}
export interface SkillagerExposureEffect {
  readonly path: string
  readonly action: 'create' | 'replace' | 'remove'
  readonly before: SkillagerExposureEntry | null
  readonly after: SkillagerExposureEntry | null
}
export interface SkillagerExposurePreview {
  readonly previewId: string
  readonly request: SkillagerExposureRequest
  readonly target: HostPath
  readonly sourceHash?: string
  readonly targetHash: string | null
  readonly beforeMode: number | null
  readonly afterMode: number | null
  readonly effects: readonly SkillagerExposureEffect[]
}
export interface SkillagerExposureCompletion {
  readonly status: 'exposed' | 'removed'
  readonly target: HostPath
  readonly skillId: string
  readonly mode: SkillagerExposureMode
}
export const SKILLAGER_EXPOSURE_MAX_EFFECTS = 2_048
