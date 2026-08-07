import {
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewCommentLifecycle,
  type ReviewPolicyResult,
} from './document-review-types'
import {
  reviewPolicyFailure as failure,
  reviewPolicySuccess as success,
  validateReviewCommentBody,
} from './document-review-validation'

export function editDocumentReviewComment(
  model: DocumentReviewModel,
  commentId: string,
  body: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const comment = findComment(model, commentId)
  if (!comment) return failure('unknown-comment', 'The review comment does not exist')
  if (comment.lifecycle !== 'draft') {
    return failure('comment-not-draft', 'Only draft comments may be edited')
  }
  const bodyError = validateReviewCommentBody(body)
  if (bodyError) return { ok: false, error: bodyError }
  return success(updateComment(model, commentId, (current) => ({ ...current, body })))
}

export function removeDocumentReviewComment(
  model: DocumentReviewModel,
  commentId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const comment = findComment(model, commentId)
  if (!comment) return failure('unknown-comment', 'The review comment does not exist')
  if (comment.lifecycle !== 'draft') {
    return failure('comment-not-draft', 'Sent review history is cleared explicitly')
  }
  return success(withoutComments(model, new Set([commentId])))
}

export function reviewStaleDocumentComment(
  model: DocumentReviewModel,
  commentId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const comment = findComment(model, commentId)
  if (!comment) return failure('unknown-comment', 'The review comment does not exist')
  if (comment.lifecycle !== 'draft') {
    return failure('comment-not-draft', 'Only draft comments can enter delivery')
  }
  if (comment.anchor.state.status !== 'stale') {
    return failure('not-stale', 'The review comment is not stale')
  }
  return success(
    updateComment(model, commentId, (current) => ({
      ...current,
      anchor: {
        ...current.anchor,
        state: { ...current.anchor.state, reviewed: true },
      },
    })),
  )
}

export function resolveDocumentReviewComment(
  model: DocumentReviewModel,
  commentId: string,
): ReviewPolicyResult<DocumentReviewModel> {
  const comment = findComment(model, commentId)
  if (!comment) return failure('unknown-comment', 'The review comment does not exist')
  if (comment.lifecycle !== 'sent') {
    return failure('comment-not-sent', 'Only sent comments may be resolved')
  }
  return success(
    updateComment(model, commentId, (current) => ({
      ...current,
      lifecycle: 'resolved',
    })),
  )
}

export function clearDocumentReviewHistory(
  model: DocumentReviewModel,
  history: 'all' | Exclude<ReviewCommentLifecycle, 'draft'>,
): ReviewPolicyResult<DocumentReviewModel> {
  const removed = new Set(
    model.comments
      .filter(
        (comment) =>
          comment.lifecycle !== 'draft' &&
          (history === 'all' || comment.lifecycle === history),
      )
      .map((comment) => comment.id),
  )
  return success(withoutComments(model, removed))
}

function findComment(
  model: DocumentReviewModel,
  id: string,
): DocumentReviewComment | undefined {
  return model.comments.find((comment) => comment.id === id)
}

function updateComment(
  model: DocumentReviewModel,
  id: string,
  update: (comment: DocumentReviewComment) => DocumentReviewComment,
): DocumentReviewModel {
  return {
    ...model,
    comments: model.comments.map((comment) =>
      comment.id === id ? update(comment) : comment,
    ),
  }
}

function withoutComments(
  model: DocumentReviewModel,
  removed: ReadonlySet<string>,
): DocumentReviewModel {
  if (removed.size === 0) return model
  return {
    ...model,
    comments: model.comments.filter((comment) => !removed.has(comment.id)),
    batches: model.batches.flatMap((batch) => {
      const commentIds = batch.commentIds.filter((id) => !removed.has(id))
      return commentIds.length === 0 ? [] : [{ ...batch, commentIds }]
    }),
  }
}
