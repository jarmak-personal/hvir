import { containsHostPath, type HostPath } from '../../../shared'
import type { ViewerWorkspaceModel } from './viewer-workspace-model'

export interface ViewerPathRemovalReview {
  readonly openCount: number
  readonly dirtyPaths: readonly HostPath[]
}

export interface ViewerPathRemovalResult extends ViewerPathRemovalReview {
  readonly closedCount: number
}

export interface ViewerPathRemovalCapability {
  readonly reviewPathRemoval: (target: HostPath) => ViewerPathRemovalReview
  /** Close only tabs that are still clean at the instant this method runs. */
  readonly closeCleanPath: (target: HostPath) => ViewerPathRemovalResult
}

export function reviewViewerPathRemoval(
  model: ViewerWorkspaceModel,
  target: HostPath,
): ViewerPathRemovalReview {
  const affected = model.tabs.filter((tab) => containsHostPath(target, tab.path))
  return {
    openCount: affected.length,
    dirtyPaths: affected.filter((tab) => tab.dirty).map((tab) => tab.path),
  }
}

export function closeCleanViewerPath(
  model: ViewerWorkspaceModel,
  target: HostPath,
  closeTab: (id: string) => void,
): ViewerPathRemovalResult {
  const review = reviewViewerPathRemoval(model, target)
  const closing = model.tabs.filter(
    (tab) => !tab.dirty && containsHostPath(target, tab.path),
  )
  for (const tab of closing) closeTab(tab.id)
  return { ...review, closedCount: closing.length }
}
