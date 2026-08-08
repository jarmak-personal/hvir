import type {
  DocumentReviewModel,
  ReviewAnchorStaleReason,
  ReviewCommentLifecycle,
  ReviewDocumentSnapshot,
  ReviewSourceRange,
  ReviewWorkspaceIdentity,
} from '../../../shared/document-review'
import type { HostPath } from '../../../shared'

export * from '../../../shared/document-review'

export interface ReviewAnchorCapture {
  readonly document: HostPath
  readonly snapshot: ReviewDocumentSnapshot
  readonly content: string
  readonly range: ReviewSourceRange
}

interface WorkspaceAction {
  readonly workspace: ReviewWorkspaceIdentity
}

export type DocumentReviewAction =
  | (WorkspaceAction & {
      readonly type: 'add-comment'
      readonly commentId: string
      readonly body: string
      readonly capture: ReviewAnchorCapture
      readonly batchId?: string
    })
  | (WorkspaceAction & {
      readonly type: 'edit-comment'
      readonly commentId: string
      readonly body: string
    })
  | (WorkspaceAction & { readonly type: 'remove-comment'; readonly commentId: string })
  | (WorkspaceAction & { readonly type: 'discard-batch'; readonly batchId: string })
  | (WorkspaceAction & { readonly type: 'review-stale'; readonly commentId: string })
  | (WorkspaceAction & {
      readonly type: 'revalidate-document'
      readonly document: HostPath
      readonly snapshot: ReviewDocumentSnapshot
      readonly content: string
    })
  | (WorkspaceAction & {
      readonly type: 'mark-document-stale'
      readonly document: HostPath
      readonly reason: Exclude<
        ReviewAnchorStaleReason,
        'ambiguous-match' | 'invalid-snapshot' | 'missing-match' | 'read-limit-exceeded'
      >
    })
  | (WorkspaceAction & {
      readonly type: 'clear-history'
      readonly history: 'all' | Exclude<ReviewCommentLifecycle, 'draft'>
    })
  | (WorkspaceAction & {
      readonly type: 'create-batch'
      readonly batchId: string
      readonly commentIds: readonly string[]
    })
  | (WorkspaceAction & {
      readonly type: 'add-to-batch'
      readonly batchId: string
      readonly commentId: string
    })
  | (WorkspaceAction & {
      readonly type: 'remove-from-batch'
      readonly batchId: string
      readonly commentId: string
    })

export interface ReviewPolicyError {
  readonly code:
    | 'anchor-context-too-large'
    | 'anchor-excerpt-too-large'
    | 'batch-limit'
    | 'batch-membership-limit'
    | 'comment-limit'
    | 'comment-not-draft'
    | 'document-comment-limit'
    | 'document-outside-workspace'
    | 'duplicate-batch'
    | 'duplicate-comment'
    | 'duplicate-member'
    | 'empty-batch'
    | 'empty-comment'
    | 'empty-excerpt'
    | 'foreign-document'
    | 'id-too-large'
    | 'invalid-anchor'
    | 'invalid-batch'
    | 'invalid-comment'
    | 'invalid-id'
    | 'invalid-source-range'
    | 'invalid-workspace'
    | 'not-stale'
    | 'read-limit-exceeded'
    | 'snapshot-mismatch'
    | 'stored-workspace-limit'
    | 'text-too-large'
    | 'unknown-batch'
    | 'unknown-comment'
    | 'unsupported-document'
    | 'workspace-mismatch'
  readonly message: string
}

export type ReviewPolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ReviewPolicyError }

export type DocumentReviewActionResult =
  | { readonly ok: true; readonly model: DocumentReviewModel }
  | {
      readonly ok: false
      readonly model: DocumentReviewModel
      readonly error: ReviewPolicyError
    }

export type ReviewDeliveryExclusion =
  'invalid-record' | 'resolved' | 'sent' | 'stale-unreviewed'

export type ReviewDeliveryEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: ReviewDeliveryExclusion }
