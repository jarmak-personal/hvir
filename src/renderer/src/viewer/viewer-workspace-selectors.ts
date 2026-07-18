import { hostPathEquals, type HostPath } from '../../../shared'
import type { ViewerPaneId, ViewerTab } from './tab-state'
import type { ViewerWorkspaceModel } from './viewer-workspace-model'

export function selectActiveTab(model: ViewerWorkspaceModel): ViewerTab | undefined {
  return model.tabs.find((tab) => tab.id === model.activeId)
}

export function selectPaneTabs(
  model: ViewerWorkspaceModel,
  pane: ViewerPaneId,
): readonly ViewerTab[] {
  return model.tabs.filter((tab) => tab.pane === pane)
}

export function selectPaneActiveTab(
  model: ViewerWorkspaceModel,
  pane: ViewerPaneId,
): ViewerTab | undefined {
  const tabs = selectPaneTabs(model, pane)
  return tabs.find((tab) => tab.id === model.activeByPane[pane]) ?? tabs[0]
}

export function sameViewerWorkspace(
  model: ViewerWorkspaceModel,
  root: HostPath,
): boolean {
  return Boolean(model.root && hostPathEquals(model.root, root))
}
