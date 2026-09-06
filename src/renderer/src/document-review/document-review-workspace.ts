import type {
  DocumentReviewRevalidation,
  DocumentReviewStoreNotice,
  DocumentReviewWorkspaceSnapshot,
  ReviewWorkspaceIdentity,
} from '../../../shared/document-review'
import type { HostPath } from '../../../shared/host-path'
import type {
  DocumentReviewAction,
  DocumentReviewActionResult,
  DocumentReviewModel,
} from './document-review-types'

export interface DocumentReviewWorkspaceState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly localGeneration: number
  readonly workspace?: ReviewWorkspaceIdentity
  readonly workspaceGeneration?: number
  readonly revision: number
  readonly model?: DocumentReviewModel
  readonly notice?: DocumentReviewStoreNotice
  readonly error?: string
}

/** The workspace capability shared by review interaction and delivery. */
export interface DocumentReviewWorkspaceBinding {
  readonly state: DocumentReviewWorkspaceState
  readonly apply: (action: DocumentReviewAction) => DocumentReviewActionResult
  readonly readDocument: (document: HostPath) => Promise<DocumentReviewRevalidation>
  readonly flush: () => Promise<void>
  readonly adoptAuthoritative: (snapshot: DocumentReviewWorkspaceSnapshot) => boolean
}
