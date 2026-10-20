import { containsHostPath, hostPathEquals, type HostPath } from '../../../shared'
import type { ViewerWorkspaceModel } from './viewer-workspace-model'
import type { RetainedViewerWorkspaceCache } from './retained-viewer-workspace-cache'
import {
  persistViewerTabs,
  restoreViewerTabs,
  viewerStorageKey,
} from './viewer-workspace-persistence'
import {
  closeCleanViewerPath,
  reviewViewerPathRemoval,
  type ViewerPathRemovalCapability,
  type ViewerPathRemovalReview,
  type ViewerPathRemovalResult,
} from './viewer-path-removal'

export interface WorkspacePathRemovalCapability {
  reviewWorkspacePathRemoval(root: HostPath, target: HostPath): ViewerPathRemovalReview
  closeWorkspaceCleanPath(root: HostPath, target: HostPath): ViewerPathRemovalResult
}

/** Exact-workspace tab ownership for trusted operations outside the active Files pane. */
export function workspacePathRemoval(
  current: () => ViewerWorkspaceModel,
  retained: RetainedViewerWorkspaceCache,
  active: ViewerPathRemovalCapability,
): WorkspacePathRemovalCapability {
  const inactive = (root: HostPath) =>
    retained.peek(viewerStorageKey(root)) ?? restoreViewerTabs(root)
  const assertTarget = (root: HostPath, target: HostPath) => {
    if (!containsHostPath(root, target))
      throw new Error('Removal target escapes its workspace')
  }
  return {
    reviewWorkspacePathRemoval(root, target) {
      assertTarget(root, target)
      const model = current()
      if (model.root && hostPathEquals(model.root, root))
        return active.reviewPathRemoval(target)
      return reviewViewerPathRemoval(inactive(root), target)
    },
    closeWorkspaceCleanPath(root, target) {
      assertTarget(root, target)
      const model = current()
      if (model.root && hostPathEquals(model.root, root))
        return active.closeCleanPath(target)
      const workspace = inactive(root)
      const closing = new Set<string>()
      const result = closeCleanViewerPath(workspace, target, (id) => closing.add(id))
      const tabs = workspace.tabs.filter((tab) => !closing.has(tab.id))
      const next = {
        tabs,
        activeId: tabs.find((tab) => tab.id === workspace.activeId)?.id ?? tabs[0]?.id,
      }
      retained.set(viewerStorageKey(root), next)
      persistViewerTabs(root, tabs, next.activeId)
      return result
    },
  }
}
