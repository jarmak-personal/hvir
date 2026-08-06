import { containsHostPath, hostPathEquals } from '../../../shared'
import {
  DOCUMENT_REVIEW_LIMITS,
  type ReviewPolicyError,
  type ReviewPolicyResult,
  type ReviewWorkspaceIdentity,
} from './document-review-types'
import type { HostPath } from '../../../shared'

export function reviewWorkspaceEquals(
  left: ReviewWorkspaceIdentity,
  right: ReviewWorkspaceIdentity,
): boolean {
  return left.id === right.id && hostPathEquals(left.root, right.root)
}

export function validateReviewWorkspace(
  workspace: ReviewWorkspaceIdentity,
): ReviewPolicyError | undefined {
  if (
    !isValidReviewId(workspace.id, DOCUMENT_REVIEW_LIMITS.workspaceIdBytes) ||
    !workspace.root.path.startsWith('/')
  ) {
    return reviewPolicyError(
      'invalid-workspace',
      'A review workspace needs a bounded stable identity and an absolute host path',
    )
  }
  return undefined
}

export function validateReviewDocument(
  workspace: ReviewWorkspaceIdentity,
  document: HostPath,
): ReviewPolicyError | undefined {
  if (workspace.root.hostId !== document.hostId) {
    return reviewPolicyError('foreign-document', 'The document belongs to another host')
  }
  if (
    !containsHostPath(workspace.root, document) ||
    hostPathEquals(workspace.root, document)
  ) {
    return reviewPolicyError(
      'document-outside-workspace',
      'The document is outside the exact review workspace',
    )
  }
  if (!/\.(?:md|markdown)$/i.test(document.path)) {
    return reviewPolicyError(
      'unsupported-document',
      'Document review supports Markdown only',
    )
  }
  return undefined
}

export function validateReviewCommentBody(body: string): ReviewPolicyError | undefined {
  if (body.trim().length === 0) {
    return reviewPolicyError('empty-comment', 'A review comment cannot be empty')
  }
  if (reviewUtf8Bytes(body) > DOCUMENT_REVIEW_LIMITS.commentBytes) {
    return reviewPolicyError(
      'text-too-large',
      'The review comment exceeds its byte limit',
    )
  }
  return undefined
}

export function isValidReviewId(id: string, maximumBytes: number): boolean {
  if (id.length === 0 || reviewUtf8Bytes(id) > maximumBytes) return false
  for (const character of id) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 31 || codePoint === 127) return false
  }
  return true
}

export function reviewUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function reviewPolicySuccess<T>(value: T): ReviewPolicyResult<T> {
  return { ok: true, value }
}

export function reviewPolicyFailure<T>(error: ReviewPolicyError): ReviewPolicyResult<T>
export function reviewPolicyFailure<T>(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyResult<T>
export function reviewPolicyFailure<T>(
  errorOrCode: ReviewPolicyError | ReviewPolicyError['code'],
  message?: string,
): ReviewPolicyResult<T> {
  return {
    ok: false,
    error:
      typeof errorOrCode === 'string'
        ? reviewPolicyError(errorOrCode, message ?? 'Document review policy rejected')
        : errorOrCode,
  }
}

export function reviewPolicyError(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyError {
  return { code, message }
}
