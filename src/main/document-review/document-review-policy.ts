import {
  containsHostPath,
  DOCUMENT_REVIEW_LIMITS,
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

export function documentReviewUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function isDocumentReviewIdentifier(
  value: unknown,
  maximumBytes: number = DOCUMENT_REVIEW_LIMITS.idBytes,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    documentReviewUtf8Bytes(value) <= maximumBytes &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 31 || code === 127
    })
  )
}
