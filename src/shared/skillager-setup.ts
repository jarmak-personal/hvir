import type { HostPath } from './host-path'

export interface SkillagerSetupTarget {
  readonly selectionId: string
  readonly root: HostPath
}

export interface SkillagerSetup {
  readonly target?: SkillagerSetupTarget
  readonly needsReconciliation: boolean
  readonly gitHistory?: boolean
  readonly message?: string
}
