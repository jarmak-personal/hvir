import { validateDocumentReviewAnchor } from './document-review-anchor'
import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewDeliveryEligibility,
  type ReviewPolicyError,
} from './document-review-types'
import {
  isValidReviewId,
  reviewPolicyError,
  reviewWorkspaceEquals,
  validateReviewCommentBody,
  validateReviewDocument,
} from './document-review-validation'

export function reviewCommentDeliveryEligibility(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): ReviewDeliveryEligibility {
  if (validateDocumentReviewCommentRecord(model, comment)) {
    return { eligible: false, reason: 'invalid-record' }
  }
  if (comment.lifecycle === 'sent') return { eligible: false, reason: 'sent' }
  if (comment.lifecycle === 'resolved') return { eligible: false, reason: 'resolved' }
  if (comment.anchor.state.status === 'stale' && !comment.anchor.state.reviewed) {
    return { eligible: false, reason: 'stale-unreviewed' }
  }
  return { eligible: true }
}

export function validateDocumentReviewCommentRecord(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): ReviewPolicyError | undefined {
  if (
    !reviewWorkspaceEquals(model.workspace, comment.workspace) ||
    validateReviewDocument(model.workspace, comment.document) ||
    !isValidReviewId(comment.id, DOCUMENT_REVIEW_LIMITS.idBytes) ||
    validateReviewCommentBody(comment.body) ||
    validateDocumentReviewAnchor(comment.anchor) ||
    (comment.lifecycle !== 'draft' &&
      comment.lifecycle !== 'sent' &&
      comment.lifecycle !== 'resolved')
  ) {
    return reviewPolicyError('invalid-comment', 'The review comment record is invalid')
  }
  return undefined
}

/** Admission for new batch membership; existing members may later become ineligible. */
export function validateReviewBatchCandidate(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): ReviewPolicyError | undefined {
  const eligibility = reviewCommentDeliveryEligibility(model, comment)
  if (eligibility.eligible) return undefined
  return reviewPolicyError(
    eligibility.reason === 'sent' || eligibility.reason === 'resolved'
      ? 'comment-not-draft'
      : 'invalid-comment',
    'Only an eligible draft comment can join a review batch',
  )
}
