import { dirnameHostPath, hostPath, type FileType, type HostPath } from '../../../shared'

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
