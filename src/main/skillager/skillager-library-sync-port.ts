import type { HostPath } from '../../shared/host-path'
import type {
  SkillagerSyncCompletion,
  SkillagerSyncStatus,
} from '../../shared/skillager-library-sync'
import type { SkillagerCliSelection } from './skillager-port'

export interface SkillagerLibrarySyncCliPort {
  syncStatus(
    selection: SkillagerCliSelection,
    workspace: HostPath,
    signal: AbortSignal,
  ): Promise<SkillagerSyncStatus>
  syncApproved(
    selection: SkillagerCliSelection,
    workspace: HostPath,
    signal: AbortSignal,
    submitted: () => void,
  ): Promise<SkillagerSyncCompletion>
}
