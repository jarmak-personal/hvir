import type { HostPath } from '../../../shared'

export function projectFileOwnerKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}
