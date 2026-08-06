import { containsHostPath, hostPathEquals } from '../../../shared'
import {
  captureDocumentReviewAnchor,
  revalidateDocumentReviewAnchor,
  staleDocumentReviewAnchor,
} from './document-review-anchor'
import {
  addDocumentReviewBatchMember,
  createDocumentReviewBatch,
  deleteDocumentReviewBatch,
  removeDocumentReviewBatchMember,
} from './document-review-batches'
import {
  clearDocumentReviewHistory,
  editDocumentReviewComment,
  markDocumentReviewCommentsSent,
  removeDocumentReviewComment,
  resolveDocumentReviewComment,
  reviewStaleDocumentComment,
  validateReviewCommentBody,
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
      return applyModelResult(
        model,
        editDocumentReviewComment(model, action.commentId, action.body),
      )
    case 'remove-comment':
      return applyModelResult(model, removeDocumentReviewComment(model, action.commentId))
    case 'reanchor-comment':
      return reanchorComment(model, action.commentId, action.capture)
    case 'review-stale':
      return applyModelResult(model, reviewStaleDocumentComment(model, action.commentId))
    case 'revalidate-document':
      return revalidateDocument(model, action.document, action.snapshot, action.content)
    case 'mark-document-stale':
      return markDocumentStale(model, action.document, action.reason)
    case 'mark-sent':
      return applyModelResult(
        model,
        markDocumentReviewCommentsSent(model, action.commentIds),
      )
    case 'resolve-comment':
      return applyModelResult(
        model,
        resolveDocumentReviewComment(model, action.commentId),
      )
    case 'clear-history':
      return applyModelResult(model, clearDocumentReviewHistory(model, action.history))
    case 'create-batch':
      return createBatch(model, action.batchId, action.commentIds)
    case 'add-to-batch':
      return applyModelResult(
        model,
        addDocumentReviewBatchMember(model, action.batchId, action.commentId),
      )
    case 'remove-from-batch':
      return applyModelResult(
        model,
        removeDocumentReviewBatchMember(model, action.batchId, action.commentId),
      )
    case 'delete-batch':
      return applyModelResult(model, deleteDocumentReviewBatch(model, action.batchId))
  }
}

export function reviewWorkspaceEquals(
  left: ReviewWorkspaceIdentity,
  right: ReviewWorkspaceIdentity,
): boolean {
  return left.id === right.id && hostPathEquals(left.root, right.root)
}

export function validateReviewWorkspace(
  workspace: ReviewWorkspaceIdentity,
): ReviewPolicyError | undefined {
  if (
    !isValidReviewId(workspace.id, DOCUMENT_REVIEW_LIMITS.workspaceIdBytes) ||
    !workspace.root.path.startsWith('/')
  ) {
    return policyError(
      'invalid-workspace',
      'A review workspace needs a bounded stable identity and an absolute host path',
    )
  }
  return undefined
}

export function validateReviewDocument(
  workspace: ReviewWorkspaceIdentity,
  document: ReviewAnchorCapture['document'],
): ReviewPolicyError | undefined {
  if (workspace.root.hostId !== document.hostId) {
    return policyError('foreign-document', 'The document belongs to another host')
  }
  if (
    !containsHostPath(workspace.root, document) ||
    hostPathEquals(workspace.root, document)
  ) {
    return policyError(
      'document-outside-workspace',
      'The document is outside the exact review workspace',
    )
  }
  if (!/\.(?:md|markdown)$/i.test(document.path)) {
    return policyError('unsupported-document', 'Document review supports Markdown only')
  }
  return undefined
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
  return acceptBounded(model, {
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
  return acceptBounded(
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
  return acceptBounded(model, {
    ...model,
    comments: model.comments.map((comment) =>
      hostPathEquals(comment.document, document)
        ? {
            ...comment,
            anchor: revalidateDocumentReviewAnchor(comment.anchor, snapshot, content),
          }
        : comment,
    ),
  })
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
  return applyModelResult(model, createDocumentReviewBatch(model, batchId, commentIds))
}

function validateId(id: string): ReviewPolicyError | undefined {
  if (!isValidReviewId(id, DOCUMENT_REVIEW_LIMITS.idBytes)) {
    return policyError(
      utf8Bytes(id) > DOCUMENT_REVIEW_LIMITS.idBytes ? 'id-too-large' : 'invalid-id',
      'Review identifiers must be bounded non-control text',
    )
  }
  return undefined
}

export function isValidReviewId(id: string, maximumBytes: number): boolean {
  if (id.length === 0 || utf8Bytes(id) > maximumBytes) return false
  for (const character of id) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 31 || codePoint === 127) return false
  }
  return true
}

function acceptBounded(
  current: DocumentReviewModel,
  candidate: DocumentReviewModel,
): DocumentReviewActionResult {
  return utf8Bytes(JSON.stringify(candidate)) >
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

function applyModelResult(
  current: DocumentReviewModel,
  result: ReviewPolicyResult<DocumentReviewModel>,
): DocumentReviewActionResult {
  return result.ok
    ? acceptBounded(current, result.value)
    : rejectedWith(current, result.error)
}

function accepted(model: DocumentReviewModel): DocumentReviewActionResult {
  return { ok: true, model }
}

function rejected(
  model: DocumentReviewModel,
  code: ReviewPolicyError['code'],
  message: string,
): DocumentReviewActionResult {
  return { ok: false, model, error: policyError(code, message) }
}

function rejectedWith(
  model: DocumentReviewModel,
  error: ReviewPolicyError,
): DocumentReviewActionResult {
  return { ok: false, model, error }
}

function policyError(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyError {
  return { code, message }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
