import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewCommentLifecycle,
  type ReviewPolicyError,
  type ReviewPolicyResult,
} from './document-review-types'

export function validateReviewCommentBody(body: string): ReviewPolicyError | undefined {
  if (body.trim().length === 0) {
    return error('empty-comment', 'A review comment cannot be empty')
  }
  if (utf8Bytes(body) > DOCUMENT_REVIEW_LIMITS.commentBytes) {
    return error('text-too-large', 'The review comment exceeds its byte limit')
  }
  return undefined
}

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

export function markDocumentReviewCommentsSent(
  model: DocumentReviewModel,
  commentIds: readonly string[],
): ReviewPolicyResult<DocumentReviewModel> {
  const ids = new Set(commentIds)
  if (ids.size === 0 || ids.size !== commentIds.length) {
    return failure('invalid-comment', 'Sent transitions need unique draft comments')
  }
  for (const id of ids) {
    const comment = findComment(model, id)
    if (!comment) return failure('unknown-comment', 'The review comment does not exist')
    if (comment.lifecycle !== 'draft') {
      return failure('comment-not-draft', 'Only draft comments may be marked sent')
    }
    if (comment.anchor.state.status === 'stale' && !comment.anchor.state.reviewed) {
      return failure('invalid-comment', 'Unreviewed stale comments cannot be sent')
    }
  }
  return success({
    ...model,
    comments: model.comments.map((comment) =>
      ids.has(comment.id) ? { ...comment, lifecycle: 'sent' as const } : comment,
    ),
  })
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
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
