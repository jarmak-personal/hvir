import type { HostPath } from '../../../shared'

export const DOCUMENT_REVIEW_LIMITS = {
  batchesPerWorkspace: 32,
  batchMembers: 64,
  commentsPerDocument: 64,
  commentsPerWorkspace: 256,
  commentBytes: 8 * 1024,
  contextBytes: 4 * 1024,
  excerptBytes: 32 * 1024,
  idBytes: 128,
  revalidationReadBytes: 4 * 1024 * 1024,
  sourceRangeLines: 100,
  storedWorkspaceBytes: 2 * 1024 * 1024,
  workspaceIdBytes: 256,
} as const

export interface ReviewWorkspaceIdentity {
  /** Stable registered project/worktree identity, not a path-derived key. */
  readonly id: string
  readonly root: HostPath
}

export interface ReviewDocumentSnapshot {
  readonly algorithm: 'sha256'
  /** Lowercase hexadecimal digest of the exact on-disk UTF-8 bytes. */
  readonly digest: string
  readonly byteLength: number
}

export interface ReviewSourceRange {
  /** Inclusive, one-based line. */
  readonly startLine: number
  /** Inclusive, one-based line. */
  readonly endLine: number
}

export interface ReviewAnchorLocation {
  readonly snapshot: ReviewDocumentSnapshot
  readonly range: ReviewSourceRange
}

export type ReviewAnchorStaleReason =
  | 'ambiguous-match'
  | 'deleted'
  | 'host-unavailable'
  | 'incomplete-read'
  | 'invalid-snapshot'
  | 'invalid-text'
  | 'missing-match'
  | 'read-limit-exceeded'

export type ReviewAnchorState =
  | { readonly status: 'current' }
  | { readonly status: 'moved'; readonly previous: ReviewAnchorLocation }
  | {
      readonly status: 'stale'
      readonly reason: ReviewAnchorStaleReason
      /** Explicit human decision; staleness remains visible and orthogonal. */
      readonly reviewed: boolean
    }

/** Representation-independent source identity shared by rendered and source capture. */
export interface DocumentReviewAnchor {
  readonly snapshot: ReviewDocumentSnapshot
  readonly range: ReviewSourceRange
  readonly excerpt: string
  /** Exact immediately preceding source, including its line delimiter. */
  readonly contextBefore: string
  /** Exact immediately following source, including its line delimiter. */
  readonly contextAfter: string
  readonly state: ReviewAnchorState
}

export type ReviewCommentLifecycle = 'draft' | 'sent' | 'resolved'

export interface DocumentReviewComment {
  readonly id: string
  readonly workspace: ReviewWorkspaceIdentity
  readonly document: HostPath
  readonly body: string
  readonly anchor: DocumentReviewAnchor
  readonly lifecycle: ReviewCommentLifecycle
}

export interface DocumentReviewBatch {
  readonly id: string
  readonly workspace: ReviewWorkspaceIdentity
  readonly commentIds: readonly string[]
}

export interface DocumentReviewModel {
  readonly workspace: ReviewWorkspaceIdentity
  readonly comments: readonly DocumentReviewComment[]
  readonly batches: readonly DocumentReviewBatch[]
}

export interface ReviewAnchorCapture {
  readonly representation: 'rendered-block' | 'source-range'
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
    })
  | (WorkspaceAction & {
      readonly type: 'edit-comment'
      readonly commentId: string
      readonly body: string
    })
  | (WorkspaceAction & { readonly type: 'remove-comment'; readonly commentId: string })
  | (WorkspaceAction & {
      readonly type: 'reanchor-comment'
      readonly commentId: string
      readonly capture: ReviewAnchorCapture
    })
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
      readonly type: 'mark-sent'
      readonly commentIds: readonly string[]
    })
  | (WorkspaceAction & { readonly type: 'resolve-comment'; readonly commentId: string })
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
  | (WorkspaceAction & { readonly type: 'delete-batch'; readonly batchId: string })

export interface ReviewPolicyError {
  readonly code:
    | 'anchor-context-too-large'
    | 'anchor-excerpt-too-large'
    | 'batch-limit'
    | 'batch-membership-limit'
    | 'comment-limit'
    | 'comment-not-draft'
    | 'comment-not-sent'
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

export interface ReviewBatchMember {
  readonly comment: DocumentReviewComment
  readonly eligibility: ReviewDeliveryEligibility
}

export interface ReviewBatchDocumentGroup {
  readonly document: HostPath
  readonly relativePath: string
  readonly members: readonly ReviewBatchMember[]
}
