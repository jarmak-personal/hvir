import { hostPathEquals } from '../../../shared'
import {
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewPolicyResult,
} from './document-review-types'
import { validateReviewDocument } from './document-review-validation'

export function selectDocumentReviewComments(
  model: DocumentReviewModel,
  document: DocumentReviewComment['document'],
): ReviewPolicyResult<readonly DocumentReviewComment[]> {
  const documentError = validateReviewDocument(model.workspace, document)
  if (documentError) return { ok: false, error: documentError }
  return {
    ok: true,
    value: model.comments
      .filter((comment) => hostPathEquals(comment.document, document))
      .toSorted(compareComments),
  }
}

function compareComments(
  left: DocumentReviewComment,
  right: DocumentReviewComment,
): number {
  if (left.document.path !== right.document.path) {
    return left.document.path < right.document.path ? -1 : 1
  }
  if (left.anchor.range.startLine !== right.anchor.range.startLine) {
    return left.anchor.range.startLine - right.anchor.range.startLine
  }
  if (left.anchor.range.endLine !== right.anchor.range.endLine) {
    return left.anchor.range.endLine - right.anchor.range.endLine
  }
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1
}
