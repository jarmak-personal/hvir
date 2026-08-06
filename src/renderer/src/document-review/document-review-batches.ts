import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewBatch,
  type DocumentReviewModel,
  type ReviewPolicyError,
  type ReviewPolicyResult,
} from './document-review-types'

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
  const membershipError = validateBatchMembers(model, [...batch.commentIds, commentId])
  if (membershipError) return { ok: false, error: membershipError }
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

export function deleteDocumentReviewBatch(
  model: DocumentReviewModel,
  batchId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  if (!model.batches.some((batch) => batch.id === batchId)) {
    return failure('unknown-batch', 'The review batch does not exist')
  }
  return success({
    ...model,
    batches: model.batches.filter((batch) => batch.id !== batchId),
  })
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
    if (comment.lifecycle !== 'draft') {
      return error('comment-not-draft', 'Only draft comments can join a review batch')
    }
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

function success<T>(value: T): ReviewPolicyResult<T> {
  return { ok: true, value }
}

function failure<T>(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyResult<T> {
  return { ok: false, error: error(code, message) }
}

function error(code: ReviewPolicyError['code'], message: string): ReviewPolicyError {
  return { code, message }
}
