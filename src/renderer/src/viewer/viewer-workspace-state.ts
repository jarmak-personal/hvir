import type { HostPath } from '../../../shared/host-path'
import type { ViewerPaneId, ViewerTab } from './tab-state'

/** Workspace state consumed by reducers, read policy, and path operations. */
export interface ViewerWorkspaceModel {
  readonly root?: HostPath
  readonly generation: number
  readonly tabs: readonly ViewerTab[]
  readonly activeId?: string
  readonly activePane: ViewerPaneId
  readonly activeByPane: Readonly<Record<ViewerPaneId, string | undefined>>
  readonly split: boolean
  readonly restored: boolean
  readonly readGenerations: Readonly<Record<string, number>>
}
