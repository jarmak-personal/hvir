import { asHostId, hostPath, type HostPath } from '../../shared'

/** Reconstruct one normalized absolute path at the main-process IPC trust boundary. */
export function reconstructIpcHostPath(candidate: HostPath): HostPath {
  if (
    !candidate ||
    typeof candidate.hostId !== 'string' ||
    typeof candidate.path !== 'string' ||
    !candidate.path.startsWith('/') ||
    candidate.path.includes('\0')
  ) {
    throw new Error('Invalid host-qualified project path')
  }
  const decoded = hostPath(asHostId(candidate.hostId), candidate.path)
  if (decoded.path !== candidate.path) {
    throw new Error('Project paths must already be normalized')
  }
  return decoded
}
