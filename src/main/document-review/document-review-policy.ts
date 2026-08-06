import {
  containsHostPath,
  hostPathEquals,
  type HostPath,
  type ReviewWorkspaceIdentity,
} from '../../shared'

export function isDocumentReviewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function documentReviewWorkspaceEquals(
  left: ReviewWorkspaceIdentity,
  right: ReviewWorkspaceIdentity,
): boolean {
  return left.id === right.id && hostPathEquals(left.root, right.root)
}

export function isDocumentReviewDocument(
  workspace: ReviewWorkspaceIdentity,
  document: HostPath,
): boolean {
  return (
    document.hostId === workspace.root.hostId &&
    containsHostPath(workspace.root, document) &&
    !hostPathEquals(workspace.root, document) &&
    /\.(?:md|markdown)$/i.test(document.path)
  )
}
