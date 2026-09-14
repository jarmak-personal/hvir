import { SKILLAGER_ACCEPTED_TRUST } from '../../../shared/skillager'
import { isNativeProjectSkill } from './skillager-model'
import { hostPathEquals } from '../../../shared/host-path'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type {
  SkillagerDestination,
  SkillagerExposureRequest,
} from '../../../shared/skillager-exposure'
import type { CurationAction } from './skillager-curation-model'
import type { ProjectState } from '../../../shared/workspace-types'

export type ExposureAction =
  SkillagerExposureRequest['action'] | CurationAction | 'files' | 'review-update'
export interface ExposureDestination extends SkillagerDestination {
  readonly projectName: string
  readonly name: string
}
export function exposureDestinations(state?: ProjectState): ExposureDestination[] {
  return (
    state?.projects.flatMap((project) =>
      project.connectionState === 'connected'
        ? project.workspaces
            .filter((workspace) => !workspace.closed && !workspace.missing)
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
  local = true,
  libraryId?: string,
): readonly { action: ExposureAction; label: string; disabled: boolean }[] {
  const owned =
    metadata.source.ownership === 'library' &&
    (!libraryId || metadata.source.libraryId === libraryId)
  const copy = metadata.workspace,
    member = metadata.routerMembership
  const native = isNativeProjectSkill(metadata)
  const approved = SKILLAGER_ACCEPTED_TRUST.some((trust) => trust === metadata.trust)
  const present = !['removed', 'absent'].includes(copy?.status ?? '')
  if (native)
    return [
      { action: 'full', label: 'Full skill…', disabled: !local || !approved },
      { action: 'stub', label: 'Stub…', disabled: !local || !approved },
      { action: 'group', label: 'Group in router…', disabled: !local || !approved },
      {
        action: 'remove',
        label: 'Remove from this project…',
        disabled: !local || !approved,
      },
      { action: 'files', label: 'Remove in Files…', disabled: false },
    ]
  if (copy?.router)
    return [
      {
        action: 'edit-members',
        label: 'Edit members…',
        disabled: !local || !present || copy.router.kind !== 'tag',
      },
      { action: 'ungroup', label: 'Ungroup…', disabled: !local || !present },
      {
        action: 'remove',
        label: 'Remove from this project…',
        disabled: !local || !present,
      },
    ]
  if (member)
    return [
      { action: 'full', label: 'Full skill…', disabled: !local || !owned },
      { action: 'stub', label: 'Stub…', disabled: !local || !owned },
      {
        action: 'edit-members',
        label: 'Edit members…',
        disabled: !local || member.router?.kind !== 'tag',
      },
      { action: 'remove', label: 'Remove from this project…', disabled: !local },
    ]
  if (!copy)
    return [
      { action: 'add', label: 'Add to this project…', disabled: !owned },
      { action: 'group', label: 'Group in router…', disabled: !local || !owned },
    ]
  const direct = present && (copy.mode === 'native' || copy.mode === 'stub')
  return [
    {
      action: 'full',
      label: 'Full skill…',
      disabled: !local || !owned || !direct || copy.mode === 'native',
    },
    {
      action: 'stub',
      label: 'Stub…',
      disabled: !local || !owned || !direct || copy.mode === 'stub',
    },
    { action: 'group', label: 'Group in router…', disabled: !local || !owned || !direct },
    {
      action: 'review-update',
      label: 'Update…',
      disabled: !eligibleSkillagerUpdate(metadata),
    },
    {
      action: 'remove',
      label: 'Remove from this project…',
      disabled: !direct || (copy.mode === 'stub' && copy.target.hostId !== 'local'),
    },
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
    (copy.mode === 'native' ||
      (copy.mode === 'stub' && copy.target.hostId === 'local')) &&
    copy.status === 'source_update' &&
    Boolean(metadata.contentHash && copy.expectedSourceHash === metadata.contentHash)
  )
}

export function workspaceSkillLabel(metadata: SkillagerMetadata): string {
  const label = observedWorkspaceLabel(metadata)
  return metadata.workspace?.reconciliation
    ? `${label} · ${metadata.workspace.reconciliation === 'cleanup-pending' ? 'Cleanup retained' : 'Reconciliation pending'}`
    : label
}

function observedWorkspaceLabel(metadata: SkillagerMetadata): string {
  if (metadata.workspaceFreshness && metadata.workspaceFreshness !== 'fresh')
    return metadata.workspaceFreshness === 'checking'
      ? 'Checking workspace copy…'
      : 'Workspace status stale / unavailable'
  if (eligibleSkillagerUpdate(metadata)) return 'Workspace copy behind'
  const status = metadata.workspace?.status
  if (status === 'removed') return 'Workspace copy removed'
  if (status === 'absent') return 'Workspace copy absent'
  if (status === 'local_edit') return 'Workspace copy modified'
  if (metadata.trust === 'pinned') return 'Pinned source · update unavailable'
  if (metadata.trust === 'blocked') return 'Blocked source'
  if (['discovered', 'lint_blocked'].includes(metadata.trust))
    return 'Pending library review'
  if (status === 'source_unavailable') return 'Source unavailable for update'
  if (status === 'source_update' || status === 'source_unverified')
    return 'Update unverified'
  if (status === 'current') return 'Current'
  if (status === 'uncertain') return 'Delivery state uncertain'
  return status ?? 'Workspace status not checked'
}

export function exposurePermission(value: number | null): string {
  return value === null ? 'absent' : value.toString(8).padStart(4, '0')
}
