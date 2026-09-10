import {
  containsHostPath,
  type HostPath,
  type ReadFileRequest,
  type ViewMode,
} from '../../../shared'
import type { ViewerTab } from './tab-state'
import { nextViewerMode } from './viewer-position'

/** Origin metadata is presentation context; main independently validates every read. */
export function externalWorkspaceRoot(
  root: HostPath | undefined,
  path: HostPath,
): HostPath | undefined {
  return root && root.hostId === path.hostId && !containsHostPath(root, path)
    ? root
    : undefined
}

export function viewerReadRequest(
  path: HostPath,
  workspaceRoot?: HostPath,
): ReadFileRequest {
  return { path, ...(workspaceRoot ? { workspaceRoot } : {}) }
}

export function nextDocumentMode(tab: ViewerTab): ViewMode {
  if (tab.file?.binary) return tab.mode
  return tab.externalWorkspaceRoot
    ? tab.mode === 'rendered'
      ? 'source'
      : 'rendered'
    : nextViewerMode(tab.mode)
}

/** Outside-project content never enters the warm workspace cache or persistent tab record. */
export function retainWorkspaceDocuments(
  tabs: readonly ViewerTab[],
): readonly ViewerTab[] {
  return tabs
    .filter((tab) => !tab.externalWorkspaceRoot)
    .map((tab) => ({ ...tab, renderedDependencies: undefined }))
}
