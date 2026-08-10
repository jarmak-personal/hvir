import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewBatch,
  type DocumentReviewModel,
  type ReviewPolicyError,
  type ReviewPolicyResult,
} from './document-review-types'
import { validateReviewBatchCandidate } from './document-review-eligibility'
import {
  reviewPolicyError as error,
  reviewPolicyFailure as failure,
  reviewPolicySuccess as success,
} from './document-review-validation'

export function createDocumentReviewBatch(
  model: DocumentReviewModel,
  batchId: string,
  commentIds: readonly string[],
): ReviewPolicyResult<DocumentReviewModel> {
  if (model.batches.some((batch) => batch.id === batchId)) {
    return failure('duplicate-batch', 'The review batch already exists')
  }
  if (model.batches.length >= DOCUMENT_REVIEW_LIMITS.batchesPerWorkspace) {
    return failure('batch-limit', 'The workspace review batch limit was reached')
  }
  const membershipError = validateBatchMembers(model, commentIds)
  if (membershipError) return { ok: false, error: membershipError }
  return success({
    ...model,
    batches: [
      ...model.batches,
      { id: batchId, workspace: model.workspace, commentIds: [...commentIds] },
    ],
  })
}

export function addDocumentReviewBatchMember(
  model: DocumentReviewModel,
  batchId: string,
  commentId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const batch = model.batches.find((candidate) => candidate.id === batchId)
  if (!batch) return failure('unknown-batch', 'The review batch does not exist')
  if (batch.commentIds.includes(commentId)) {
    return failure('duplicate-member', 'The comment already belongs to this batch')
  }
  if (batch.commentIds.length >= DOCUMENT_REVIEW_LIMITS.batchMembers) {
    return failure('batch-membership-limit', 'The review batch member limit was reached')
  }
  const comment = model.comments.find((candidate) => candidate.id === commentId)
  if (!comment) return failure('unknown-comment', 'The review comment does not exist')
  const admissionError = validateReviewBatchCandidate(model, comment)
  if (admissionError) return { ok: false, error: admissionError }
  return success(
    updateBatch(model, batchId, (current) => ({
      ...current,
      commentIds: [...current.commentIds, commentId],
    })),
  )
}

export function removeDocumentReviewBatchMember(
  model: DocumentReviewModel,
  batchId: string,
  commentId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const batch = model.batches.find((candidate) => candidate.id === batchId)
  if (!batch) return failure('unknown-batch', 'The review batch does not exist')
  if (!batch.commentIds.includes(commentId)) {
    return failure('unknown-comment', 'The comment is not in this review batch')
  }
  const remaining = batch.commentIds.filter((id) => id !== commentId)
  return success(
    remaining.length === 0
      ? {
          ...model,
          batches: model.batches.filter((candidate) => candidate.id !== batchId),
        }
      : updateBatch(model, batchId, (current) => ({
          ...current,
          commentIds: remaining,
        })),
  )
}

function validateBatchMembers(
  model: DocumentReviewModel,
  commentIds: readonly string[],
): ReviewPolicyError | undefined {
  if (commentIds.length === 0)
    return error('empty-batch', 'A review batch cannot be empty')
  if (commentIds.length > DOCUMENT_REVIEW_LIMITS.batchMembers) {
    return error('batch-membership-limit', 'The review batch member limit was reached')
  }
  if (new Set(commentIds).size !== commentIds.length) {
    return error('duplicate-member', 'A review batch cannot repeat a comment')
  }
  for (const id of commentIds) {
    const comment = model.comments.find((candidate) => candidate.id === id)
    if (!comment) return error('unknown-comment', 'The review comment does not exist')
    const admissionError = validateReviewBatchCandidate(model, comment)
    if (admissionError) return admissionError
  }
  return undefined
}

function updateBatch(
  model: DocumentReviewModel,
  id: string,
  update: (batch: DocumentReviewBatch) => DocumentReviewBatch,
): DocumentReviewModel {
  return {
    ...model,
    batches: model.batches.map((batch) => (batch.id === id ? update(batch) : batch)),
  }
}
