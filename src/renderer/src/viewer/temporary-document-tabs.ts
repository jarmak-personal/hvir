import {
  containsHostPath,
  type HostPath,
  type ReadFileRequest,
  type ViewMode,
} from '../../../shared'
import { isTemporaryDocument } from '../../../shared/temporary-document'
import type { ViewerTab } from './tab-state'
import { nextViewerMode } from './viewer-position'

/** Origin metadata is presentation context; main independently validates every read. */
export function temporaryWorkspaceRoot(
  root: HostPath | undefined,
  path: HostPath,
): HostPath | undefined {
  return root &&
    root.hostId === path.hostId &&
    !containsHostPath(root, path) &&
    isTemporaryDocument(path)
    ? root
    : undefined
}

export function viewerReadRequest(path: HostPath, root?: HostPath): ReadFileRequest {
  const workspaceRoot = temporaryWorkspaceRoot(root, path)
  return { path, ...(workspaceRoot ? { workspaceRoot } : {}) }
}

export function nextDocumentMode(tab: ViewerTab): ViewMode {
  return tab.temporaryWorkspaceRoot
    ? tab.mode === 'rendered'
      ? 'source'
      : 'rendered'
    : nextViewerMode(tab.mode)
}

/** Temporary content never enters the warm workspace cache or persistent tab record. */
export function retainWorkspaceDocuments(
  tabs: readonly ViewerTab[],
): readonly ViewerTab[] {
  return tabs
    .filter((tab) => !tab.temporaryWorkspaceRoot)
    .map((tab) => ({ ...tab, renderedDependencies: undefined }))
}
