import type { FileType } from '../../../shared/fs-types'
import type { HostPath } from '../../../shared/host-path'

/** One tree action target and its originating focus surface. */
export interface FileActionMenuRequest {
  readonly id: number
  readonly target: HostPath
  readonly targetType: FileType
  readonly label: string
  readonly x: number
  readonly y: number
  readonly focusMenu: boolean
  readonly returnFocus?: HTMLElement
}
