import { hostPathEquals } from '../../../shared'
import {
  captureDocumentReviewAnchor,
  revalidateDocumentReviewAnchor,
  staleDocumentReviewAnchor,
} from './document-review-anchor'
import {
  addDocumentReviewBatchMember,
  createDocumentReviewBatch,
  removeDocumentReviewBatchMember,
} from './document-review-batches'
import {
  clearDocumentReviewHistory,
  editDocumentReviewComment,
  removeDocumentReviewComment,
  resolveDocumentReviewComment,
  reviewStaleDocumentComment,
} from './document-review-lifecycle'
import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewAction,
  type DocumentReviewActionResult,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewAnchorCapture,
  type ReviewAnchorStaleReason,
  type ReviewDocumentSnapshot,
  type ReviewPolicyError,
  type ReviewPolicyResult,
  type ReviewWorkspaceIdentity,
} from './document-review-types'
import {
  isValidReviewId,
  reviewPolicyError,
  reviewUtf8Bytes,
  reviewWorkspaceEquals,
  validateReviewCommentBody,
  validateReviewDocument,
  validateReviewWorkspace,
} from './document-review-validation'

export function createDocumentReviewModel(
  workspace: ReviewWorkspaceIdentity,
): ReviewPolicyResult<DocumentReviewModel> {
  const workspaceError = validateReviewWorkspace(workspace)
  return workspaceError
    ? { ok: false, error: workspaceError }
    : { ok: true, value: { workspace, comments: [], batches: [] } }
}

export function applyDocumentReviewAction(
  model: DocumentReviewModel,
  action: DocumentReviewAction,
): DocumentReviewActionResult {
  if (!reviewWorkspaceEquals(model.workspace, action.workspace)) {
    return rejected(
      model,
      'workspace-mismatch',
      'The action belongs to another workspace',
    )
  }

  switch (action.type) {
    case 'add-comment':
      return addComment(model, action.commentId, action.body, action.capture)
    case 'edit-comment':
      return applyUserAuthoredResult(
        model,
        editDocumentReviewComment(model, action.commentId, action.body),
      )
    case 'remove-comment':
      return applyAuthoritativeResult(
        model,
        removeDocumentReviewComment(model, action.commentId),
      )
    case 'reanchor-comment':
      return reanchorComment(model, action.commentId, action.capture)
    case 'review-stale':
      return applyAuthoritativeResult(
        model,
        reviewStaleDocumentComment(model, action.commentId),
      )
    case 'revalidate-document':
      return revalidateDocument(model, action.document, action.snapshot, action.content)
    case 'mark-document-stale':
      return markDocumentStale(model, action.document, action.reason)
    case 'resolve-comment':
      return applyAuthoritativeResult(
        model,
        resolveDocumentReviewComment(model, action.commentId),
      )
    case 'clear-history':
      return applyAuthoritativeResult(
        model,
        clearDocumentReviewHistory(model, action.history),
      )
    case 'create-batch':
      return createBatch(model, action.batchId, action.commentIds)
    case 'add-to-batch':
      return applyUserAuthoredResult(
        model,
        addDocumentReviewBatchMember(model, action.batchId, action.commentId),
      )
    case 'remove-from-batch':
      return applyAuthoritativeResult(
        model,
        removeDocumentReviewBatchMember(model, action.batchId, action.commentId),
      )
  }
}

function addComment(
  model: DocumentReviewModel,
  commentId: string,
  body: string,
  capture: ReviewAnchorCapture,
): DocumentReviewActionResult {
  const idError = validateId(commentId)
  if (idError) return rejectedWith(model, idError)
  if (model.comments.some((comment) => comment.id === commentId)) {
    return rejected(model, 'duplicate-comment', 'The review comment already exists')
  }
  if (model.comments.length >= DOCUMENT_REVIEW_LIMITS.commentsPerWorkspace) {
    return rejected(
      model,
      'comment-limit',
      'The workspace review comment limit was reached',
    )
  }
  const documentError = validateReviewDocument(model.workspace, capture.document)
  if (documentError) return rejectedWith(model, documentError)
  if (
    model.comments.filter((comment) => hostPathEquals(comment.document, capture.document))
      .length >= DOCUMENT_REVIEW_LIMITS.commentsPerDocument
  ) {
    return rejected(
      model,
      'document-comment-limit',
      'The document review comment limit was reached',
    )
  }
  const bodyError = validateReviewCommentBody(body)
  if (bodyError) return rejectedWith(model, bodyError)
  const captured = captureDocumentReviewAnchor(capture)
  if (!captured.ok) return rejectedWith(model, captured.error)
  return acceptUserAuthoredChange(model, {
    ...model,
    comments: [
      ...model.comments,
      {
        id: commentId,
        workspace: model.workspace,
        document: capture.document,
        body,
        anchor: captured.value,
        lifecycle: 'draft',
      },
    ],
  })
}

function reanchorComment(
  model: DocumentReviewModel,
  commentId: string,
  capture: ReviewAnchorCapture,
): DocumentReviewActionResult {
  const comment = model.comments.find((candidate) => candidate.id === commentId)
  if (!comment)
    return rejected(model, 'unknown-comment', 'The review comment does not exist')
  if (comment.lifecycle !== 'draft') {
    return rejected(model, 'comment-not-draft', 'Only draft comments may be re-anchored')
  }
  if (!hostPathEquals(comment.document, capture.document)) {
    return rejected(model, 'foreign-document', 'Re-anchoring cannot move a comment')
  }
  const captured = captureDocumentReviewAnchor(capture)
  if (!captured.ok) return rejectedWith(model, captured.error)
  return acceptUserAuthoredChange(
    model,
    updateComment(model, commentId, (current) => ({
      ...current,
      anchor: captured.value,
    })),
  )
}

function revalidateDocument(
  model: DocumentReviewModel,
  document: ReviewAnchorCapture['document'],
  snapshot: ReviewDocumentSnapshot,
  content: string,
): DocumentReviewActionResult {
  const documentError = validateReviewDocument(model.workspace, document)
  if (documentError) return rejectedWith(model, documentError)
  let changed = false
  const comments = model.comments.map((comment) => {
    if (!hostPathEquals(comment.document, document)) return comment
    const anchor = revalidateDocumentReviewAnchor(comment.anchor, snapshot, content)
    if (anchor === comment.anchor) return comment
    changed = true
    return { ...comment, anchor }
  })
  return accepted(changed ? { ...model, comments } : model)
}

function markDocumentStale(
  model: DocumentReviewModel,
  document: ReviewAnchorCapture['document'],
  reason: ReviewAnchorStaleReason,
): DocumentReviewActionResult {
  const documentError = validateReviewDocument(model.workspace, document)
  if (documentError) return rejectedWith(model, documentError)
  return accepted({
    ...model,
    comments: model.comments.map((comment) =>
      hostPathEquals(comment.document, document)
        ? { ...comment, anchor: staleDocumentReviewAnchor(comment.anchor, reason) }
        : comment,
    ),
  })
}

function createBatch(
  model: DocumentReviewModel,
  batchId: string,
  commentIds: readonly string[],
): DocumentReviewActionResult {
  const idError = validateId(batchId)
  if (idError) return rejectedWith(model, idError)
  return applyUserAuthoredResult(
    model,
    createDocumentReviewBatch(model, batchId, commentIds),
  )
}

function validateId(id: string): ReviewPolicyError | undefined {
  if (!isValidReviewId(id, DOCUMENT_REVIEW_LIMITS.idBytes)) {
    return reviewPolicyError(
      reviewUtf8Bytes(id) > DOCUMENT_REVIEW_LIMITS.idBytes
        ? 'id-too-large'
        : 'invalid-id',
      'Review identifiers must be bounded non-control text',
    )
  }
  return undefined
}

function acceptUserAuthoredChange(
  current: DocumentReviewModel,
  candidate: DocumentReviewModel,
): DocumentReviewActionResult {
  return reviewUtf8Bytes(JSON.stringify(candidate)) >
    DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes
    ? rejected(
        current,
        'stored-workspace-limit',
        'The workspace review data exceeds its stored byte limit',
      )
    : accepted(candidate)
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

function applyUserAuthoredResult(
  current: DocumentReviewModel,
  result: ReviewPolicyResult<DocumentReviewModel>,
): DocumentReviewActionResult {
  return result.ok
    ? acceptUserAuthoredChange(current, result.value)
    : rejectedWith(current, result.error)
}

function applyAuthoritativeResult(
  current: DocumentReviewModel,
  result: ReviewPolicyResult<DocumentReviewModel>,
): DocumentReviewActionResult {
  return result.ok ? accepted(result.value) : rejectedWith(current, result.error)
}

function accepted(model: DocumentReviewModel): DocumentReviewActionResult {
  return { ok: true, model }
}

function rejected(
  model: DocumentReviewModel,
  code: ReviewPolicyError['code'],
  message: string,
): DocumentReviewActionResult {
  return { ok: false, model, error: reviewPolicyError(code, message) }
}

function rejectedWith(
  model: DocumentReviewModel,
  error: ReviewPolicyError,
): DocumentReviewActionResult {
  return { ok: false, model, error }
}
