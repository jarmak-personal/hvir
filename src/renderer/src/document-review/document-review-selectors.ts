import { hostPathEquals } from '../../../shared'
import { validateDocumentReviewAnchor } from './document-review-anchor'
import {
  isValidReviewId,
  reviewWorkspaceEquals,
  validateReviewDocument,
} from './document-review-model'
import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewBatch,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewBatchDocumentGroup,
  type ReviewDeliveryEligibility,
  type ReviewPolicyError,
  type ReviewPolicyResult,
} from './document-review-types'

export function selectDocumentReviewComments(
  model: DocumentReviewModel,
  document: DocumentReviewComment['document'],
): ReviewPolicyResult<readonly DocumentReviewComment[]> {
  const documentError = validateReviewDocument(model.workspace, document)
  if (documentError) return { ok: false, error: documentError }
  return {
    ok: true,
    value: model.comments
      .filter((comment) => hostPathEquals(comment.document, document))
      .toSorted(compareComments),
  }
}

export function selectReviewBatchDocumentGroups(
  model: DocumentReviewModel,
  batchId: string,
): ReviewPolicyResult<readonly ReviewBatchDocumentGroup[]> {
  const batch = model.batches.find((candidate) => candidate.id === batchId)
  if (!batch) return failure('unknown-batch', 'The review batch does not exist')
  const batchError = validateBatch(model, batch)
  if (batchError) return { ok: false, error: batchError }

  const comments = batch.commentIds
    .map((id) => model.comments.find((comment) => comment.id === id)!)
    .toSorted(compareComments)
  const groups: ReviewBatchDocumentGroup[] = []
  for (const comment of comments) {
    const prior = groups.at(-1)
    const member = {
      comment,
      eligibility: reviewCommentDeliveryEligibility(model, comment),
    }
    if (prior && hostPathEquals(prior.document, comment.document)) {
      groups[groups.length - 1] = { ...prior, members: [...prior.members, member] }
      continue
    }
    groups.push({
      document: comment.document,
      relativePath: workspaceRelativePath(model, comment.document),
      members: [member],
    })
  }
  return { ok: true, value: groups }
}

export function reviewCommentDeliveryEligibility(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): ReviewDeliveryEligibility {
  if (!validCommentRecord(model, comment)) {
    return { eligible: false, reason: 'invalid-record' }
  }
  if (comment.lifecycle === 'sent') return { eligible: false, reason: 'sent' }
  if (comment.lifecycle === 'resolved') return { eligible: false, reason: 'resolved' }
  if (comment.anchor.state.status === 'stale' && !comment.anchor.state.reviewed) {
    return { eligible: false, reason: 'stale-unreviewed' }
  }
  return { eligible: true }
}

function validCommentRecord(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): boolean {
  return (
    reviewWorkspaceEquals(model.workspace, comment.workspace) &&
    validateReviewDocument(model.workspace, comment.document) === undefined &&
    isValidReviewId(comment.id, DOCUMENT_REVIEW_LIMITS.idBytes) &&
    comment.body.trim().length > 0 &&
    utf8Bytes(comment.body) <= DOCUMENT_REVIEW_LIMITS.commentBytes &&
    validateDocumentReviewAnchor(comment.anchor) === undefined &&
    (comment.lifecycle === 'draft' ||
      comment.lifecycle === 'sent' ||
      comment.lifecycle === 'resolved')
  )
}

function validateBatch(
  model: DocumentReviewModel,
  batch: DocumentReviewBatch,
): ReviewPolicyError | undefined {
  if (
    !reviewWorkspaceEquals(model.workspace, batch.workspace) ||
    !isValidReviewId(batch.id, DOCUMENT_REVIEW_LIMITS.idBytes) ||
    batch.commentIds.length === 0 ||
    batch.commentIds.length > DOCUMENT_REVIEW_LIMITS.batchMembers ||
    new Set(batch.commentIds).size !== batch.commentIds.length ||
    batch.commentIds.some((id) => !model.comments.some((comment) => comment.id === id))
  ) {
    return policyError('invalid-batch', 'The review batch record is invalid')
  }
  return undefined
}

function workspaceRelativePath(
  model: DocumentReviewModel,
  document: DocumentReviewComment['document'],
): string {
  return model.workspace.root.path === '/'
    ? document.path.slice(1)
    : document.path.slice(model.workspace.root.path.length + 1)
}

function compareComments(
  left: DocumentReviewComment,
  right: DocumentReviewComment,
): number {
  if (left.document.path !== right.document.path) {
    return left.document.path < right.document.path ? -1 : 1
  }
  if (left.anchor.range.startLine !== right.anchor.range.startLine) {
    return left.anchor.range.startLine - right.anchor.range.startLine
  }
  if (left.anchor.range.endLine !== right.anchor.range.endLine) {
    return left.anchor.range.endLine - right.anchor.range.endLine
  }
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function failure<T>(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyResult<T> {
  return { ok: false, error: policyError(code, message) }
}

function policyError(
  code: ReviewPolicyError['code'],
  message: string,
): ReviewPolicyError {
  return { code, message }
}
