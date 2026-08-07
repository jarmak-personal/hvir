import type { HostPath } from './host-path'

export const DOCUMENT_REVIEW_LIMITS = {
  batchesPerWorkspace: 32,
  batchMembers: 64,
  commentsPerDocument: 64,
  commentsPerWorkspace: 256,
  commentBytes: 8 * 1024,
  contextBytes: 4 * 1024,
  deliveryPayloadBytes: 64 * 1024,
  deliveryQuoteBytes: 2 * 1024,
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

export interface DocumentReviewStoreNotice {
  readonly kind: 'corrupt' | 'future-version' | 'read-failure'
  /** Basename only; review state and user-data paths remain private. */
  readonly recoveryFile?: string
  readonly writeBlocked: boolean
}

export interface DocumentReviewWorkspaceSnapshot {
  readonly workspaceGeneration: number
  readonly revision: number
  readonly model: DocumentReviewModel
  readonly notice?: DocumentReviewStoreNotice
}

export interface DocumentReviewRestoreRequest {
  readonly workspace: ReviewWorkspaceIdentity
}

export interface DocumentReviewSaveRequest extends DocumentReviewRestoreRequest {
  readonly workspaceGeneration: number
  readonly expectedRevision: number
  readonly model: DocumentReviewModel
}

export interface DocumentReviewRevalidateRequest extends DocumentReviewRestoreRequest {
  readonly workspaceGeneration: number
  readonly document: HostPath
}

export type DocumentReviewRevalidation =
  | {
      readonly status: 'read'
      readonly document: HostPath
      readonly snapshot: ReviewDocumentSnapshot
      readonly content: string
    }
  | {
      readonly status: 'stale'
      readonly document: HostPath
      readonly reason: 'deleted' | 'host-unavailable' | 'incomplete-read' | 'invalid-text'
    }

export type DocumentReviewDeliverySelection =
  | { readonly kind: 'comment'; readonly commentId: string }
  | { readonly kind: 'batch'; readonly batchId: string }

export interface DocumentReviewDeliveryPayload {
  /** Exact LF-normalized human-readable body used by Preview, Copy, and Insert. */
  readonly body: string
  readonly byteLength: number
  readonly commentIds: readonly string[]
}

export type DocumentReviewDeliveryCapability = 'copy-only' | 'insert' | 'send-now'

export interface DocumentReviewDeliveryDestination {
  readonly terminalId: string
  readonly title: string
  readonly providerName: string
  readonly lifecycle: 'live'
  readonly connection: 'connected'
  readonly attention?: import('./ipc').TerminalAttentionState
  readonly capability: DocumentReviewDeliveryCapability
}

export interface DocumentReviewDeliveryScopeRequest {
  readonly workspace: ReviewWorkspaceIdentity
  readonly workspaceGeneration: number
}

export interface DocumentReviewPreviewRequest
  extends DocumentReviewDeliveryScopeRequest {
  readonly selection: DocumentReviewDeliverySelection
}

export interface DocumentReviewPrepareRequest
  extends DocumentReviewPreviewRequest {
  readonly terminalId: string
}

export interface PreparedDocumentReviewDelivery {
  readonly id: string
  readonly destination: DocumentReviewDeliveryDestination
  readonly payload: DocumentReviewDeliveryPayload
}

export interface DocumentReviewInsertRequest {
  readonly preparedId: string
}

export interface DocumentReviewInsertResult {
  readonly outcome: 'inserted'
}

export interface DocumentReviewSendNowRequest {
  readonly preparedId: string
}

export type DocumentReviewSendNowResult =
  | {
      readonly outcome: 'sent'
      /** Authoritative durable state after PTY-boundary write completion. */
      readonly snapshot: DocumentReviewWorkspaceSnapshot
    }
  | {
      /** The prepared terminal authority was consumed to prevent a duplicate send. */
      readonly outcome: 'send-authority-consumed'
      /** Confirmed describes only the PTY boundary, never agent receipt. */
      readonly ptyAcceptance: 'confirmed' | 'indeterminate'
      readonly reason: string
    }
