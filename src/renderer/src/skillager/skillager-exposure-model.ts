import { hostPathEquals } from '../../../shared/host-path'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type {
  SkillagerDestination,
  SkillagerExposureRequest,
} from '../../../shared/skillager-exposure'
import type { ProjectState } from '../../../shared/workspace-types'

export type ExposureAction = SkillagerExposureRequest['action']
export interface ExposureDestination extends SkillagerDestination {
  readonly projectName: string
  readonly name: string
}
export function exposureDestinations(state?: ProjectState): ExposureDestination[] {
  return (
    state?.projects.flatMap((project) =>
      project.connectionState === 'connected'
        ? project.workspaces
            .filter(
              (workspace) =>
                !workspace.closed &&
                !workspace.missing &&
                workspace.root.hostId === 'local',
            )
            .map((workspace) => ({
              projectId: project.id,
              workspaceId: workspace.id,
              root: workspace.root,
              projectName: project.displayName,
              name: workspace.name,
            }))
        : [],
    ) ?? []
  )
}
export function exposureActions(
  metadata: SkillagerMetadata,
): readonly { action: ExposureAction; label: string; disabled: boolean }[] {
  const owned = metadata.source.ownership === 'library'
  const copy = metadata.workspace
  const managed =
    owned &&
    Boolean(
      copy?.skillId === metadata.id &&
      ['native', 'stub'].includes(copy.mode) &&
      copy.target.hostId === 'local',
    )
  return [
    { action: 'add', label: 'Add to project…', disabled: !owned },
    {
      action: 'change',
      label: copy?.mode === 'stub' ? 'Change to Full skill…' : 'Change to Stub…',
      disabled: !managed,
    },
    { action: 'remove', label: 'Remove workspace copy…', disabled: !managed },
  ]
}
export function exposureDestinationCurrent(
  destinations: readonly ExposureDestination[],
  destination: SkillagerDestination,
): boolean {
  return destinations.some(
    (item) =>
      item.projectId === destination.projectId &&
      item.workspaceId === destination.workspaceId &&
      hostPathEquals(item.root, destination.root),
  )
}

export function eligibleSkillagerUpdate(metadata: SkillagerMetadata): boolean {
  return metadata.workspaceFreshness === 'fresh' && observedSkillagerUpdate(metadata)
}

export function observedSkillagerUpdate(metadata: SkillagerMetadata): boolean {
  const copy = metadata.workspace
  return (
    metadata.source.ownership === 'library' &&
    ['reviewed', 'trusted'].includes(metadata.trust) &&
    copy?.skillId === metadata.id &&
    copy.target.hostId === 'local' &&
    ['native', 'stub'].includes(copy.mode) &&
    copy.status === 'source_update' &&
    Boolean(metadata.contentHash && copy.expectedSourceHash === metadata.contentHash)
  )
}

export function workspaceSkillLabel(metadata: SkillagerMetadata): string {
  if (metadata.workspaceFreshness && metadata.workspaceFreshness !== 'fresh')
    return metadata.workspaceFreshness === 'checking'
      ? 'Checking workspace copy…'
      : 'Workspace status stale / unavailable'
  if (eligibleSkillagerUpdate(metadata)) return 'Workspace copy behind'
  const status = metadata.workspace?.status
  if (status === 'local_edit') return 'Workspace copy modified'
  if (metadata.trust === 'pinned') return 'Pinned source · update unavailable'
  if (metadata.trust === 'blocked') return 'Blocked source'
  if (['discovered', 'lint_blocked'].includes(metadata.trust))
    return 'Pending library review'
  if (status === 'source_unavailable') return 'Source unavailable for update'
  if (status === 'source_update') return 'Update unverified'
  return status ?? 'Workspace status not checked'
}
