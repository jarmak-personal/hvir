import type { DiffBase, HostPath, ReadFileResponse, ViewMode } from '../../../shared'

export type ViewerPaneId = 'primary' | 'secondary'

export interface ViewerTab {
  readonly id: string
  readonly path: HostPath
  readonly pane: ViewerPaneId
  readonly pinned: boolean
  readonly mode: ViewMode
  readonly diffBase: DiffBase
  readonly diffRevision?: string
  readonly scrollTop: number
  readonly file?: ReadFileResponse
  readonly loading: boolean
  readonly error?: string
  readonly dirty: boolean
  readonly conflict: boolean
}
