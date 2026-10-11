import type { HostPath } from '../../../shared'

export interface DirectoryTreeRevealRequest {
  readonly path: HostPath
  readonly token: number
}
