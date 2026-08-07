import type { DocumentReviewRevalidation } from '../../../shared'
import type { ReviewAnchorCapture, ReviewSourceRange } from './document-review-types'

export function createDocumentReviewCapture(
  read: Extract<DocumentReviewRevalidation, { status: 'read' }>,
  range: ReviewSourceRange,
): ReviewAnchorCapture {
  return {
    document: read.document,
    content: read.content,
    range,
    snapshot: read.snapshot,
  }
}
