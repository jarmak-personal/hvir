import type { DocumentReviewModel } from '../../shared'

export const DOCUMENT_REVIEW_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const DOCUMENT_REVIEW_RETENTION_SWEEP_MS = 60 * 60 * 1_000

export interface DocumentReviewDraftActivity {
  readonly commentId: string
  readonly updatedAt: number
}

export function initialDocumentReviewDraftActivity(
  model: DocumentReviewModel,
  now: number,
): readonly DocumentReviewDraftActivity[] {
  return model.comments
    .filter((comment) => comment.lifecycle === 'draft')
    .map((comment) => ({ commentId: comment.id, updatedAt: now }))
}

export function reconcileDocumentReviewDraftActivity(
  previous:
    | {
        readonly model: DocumentReviewModel
        readonly draftActivity: readonly DocumentReviewDraftActivity[]
      }
    | undefined,
  model: DocumentReviewModel,
  now: number,
): readonly DocumentReviewDraftActivity[] {
  const previousComments = new Map(
    previous?.model.comments.map((comment) => [comment.id, comment]) ?? [],
  )
  const previousActivity = new Map(
    previous?.draftActivity.map((activity) => [activity.commentId, activity]) ?? [],
  )
  return model.comments
    .filter((comment) => comment.lifecycle === 'draft')
    .map((comment) => {
      const priorComment = previousComments.get(comment.id)
      const priorActivity = previousActivity.get(comment.id)
      return {
        commentId: comment.id,
        updatedAt:
          priorComment?.lifecycle === 'draft' &&
          priorComment.body === comment.body &&
          priorActivity
            ? priorActivity.updatedAt
            : now,
      }
    })
}

export function expireDocumentReviewDrafts(
  model: DocumentReviewModel,
  draftActivity: readonly DocumentReviewDraftActivity[],
  now: number,
): {
  readonly model: DocumentReviewModel
  readonly draftActivity: readonly DocumentReviewDraftActivity[]
  readonly changed: boolean
} {
  const cutoff = now - DOCUMENT_REVIEW_DRAFT_RETENTION_MS
  const expired = new Set(
    draftActivity
      .filter((activity) => activity.updatedAt <= cutoff)
      .map((activity) => activity.commentId),
  )
  if (expired.size === 0) return { model, draftActivity, changed: false }
  return {
    model: {
      ...model,
      comments: model.comments.filter((comment) => !expired.has(comment.id)),
      batches: model.batches.flatMap((batch) => {
        const commentIds = batch.commentIds.filter((id) => !expired.has(id))
        return commentIds.length === 0 ? [] : [{ ...batch, commentIds }]
      }),
    },
    draftActivity: draftActivity.filter((activity) => !expired.has(activity.commentId)),
    changed: true,
  }
}
