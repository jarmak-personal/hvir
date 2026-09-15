import type { SkillagerAgent } from '../../shared/skillager'
import type { ManagedDirectoryTree } from '../project-host/managed-directory'
import type { SkillagerCliSelection } from './skillager-port'

export interface SkillagerNativeSnapshot {
  readonly skillId: string
  readonly sourceHash: string
  readonly pinned: boolean
  /** CLI-selected relative native target, checked against its exclusive staging root. */
  readonly targetEntry: string
  readonly exposureId: string
  readonly tree: ManagedDirectoryTree
  readonly bytes: ReadonlyMap<string, Uint8Array>
  readonly declarations: readonly string[]
  dispose(): Promise<void>
}

export interface SkillagerNativePort {
  nativeSnapshot(
    selection: SkillagerCliSelection,
    skillId: string,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerNativeSnapshot>
  validateNativeSource(
    selection: SkillagerCliSelection,
    snapshot: Pick<SkillagerNativeSnapshot, 'skillId' | 'sourceHash'>,
    advancing: boolean,
    signal: AbortSignal,
  ): Promise<void>
}
