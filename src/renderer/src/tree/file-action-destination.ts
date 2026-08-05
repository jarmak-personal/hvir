import {
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  type FileType,
  type HostPath,
} from '../../../shared'

type FileOrganizationAction = 'rename' | 'move' | 'duplicate'

export function fileActionDestination(
  root: HostPath,
  target: HostPath,
  targetType: FileType,
): HostPath {
  if (target.hostId !== root.hostId) return root
  return targetType === 'dir'
    ? hostPath(target.hostId, target.path)
    : dirnameHostPath(target)
}

export function canOrganizeAction(
  root: HostPath,
  target: HostPath | undefined,
  targetType: FileType | undefined,
  action: FileOrganizationAction,
): boolean {
  if (!target || !targetType || hostPathEquals(target, root)) return false
  return action === 'duplicate'
    ? targetType === 'file' || targetType === 'dir'
    : targetType !== 'other'
}
