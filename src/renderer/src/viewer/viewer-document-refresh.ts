import type { HostPath } from '../../../shared'
import type { ViewerTab } from './tab-state'

export function refreshViewerTab(tab: ViewerTab, path: HostPath): ViewerTab {
  return {
    ...tab,
    refresh: { version: (tab.refresh?.version ?? 0) + 1, path },
  }
}
