import {
  documentReviewDocumentIssue,
  documentReviewUtf8Bytes,
  documentReviewWorkspaceEquals,
  isDocumentReviewIdentifier,
  type HostPath,
} from '../../../shared'
import {
  DOCUMENT_REVIEW_LIMITS,
  type ReviewPolicyError,
  type ReviewPolicyResult,
  type ReviewWorkspaceIdentity,
} from './document-review-types'

export function reviewWorkspaceEquals(
  left: ReviewWorkspaceIdentity,
  right: ReviewWorkspaceIdentity,
): boolean {
  return documentReviewWorkspaceEquals(left, right)
}

export function validateReviewWorkspace(
  workspace: ReviewWorkspaceIdentity,
): ReviewPolicyError | undefined {
  if (
    !isDocumentReviewIdentifier(workspace.id, DOCUMENT_REVIEW_LIMITS.workspaceIdBytes) ||
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
  const issue = documentReviewDocumentIssue(workspace, document)
  if (issue) {
    const message = {
      'foreign-document': 'The document belongs to another host',
      'document-outside-workspace': 'The document is outside the exact review workspace',
      'unsupported-document': 'Document review supports Markdown only',
    }[issue]
    return reviewPolicyError(issue, message)
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
  return isDocumentReviewIdentifier(id, maximumBytes)
}

export function reviewUtf8Bytes(value: string): number {
  return documentReviewUtf8Bytes(value)
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
