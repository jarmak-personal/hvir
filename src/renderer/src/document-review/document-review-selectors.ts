import { hostPathEquals } from '../../../shared'
import {
  reviewCommentDeliveryEligibility,
  validateDocumentReviewCommentRecord,
} from './document-review-eligibility'
import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewBatch,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewBatchDocumentGroup,
  type ReviewPolicyError,
  type ReviewPolicyResult,
} from './document-review-types'
import {
  isValidReviewId,
  reviewPolicyError as policyError,
  reviewPolicyFailure as failure,
  reviewWorkspaceEquals,
  validateReviewDocument,
} from './document-review-validation'

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
      members: [member],
    })
  }
  return { ok: true, value: groups }
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
    batch.commentIds.some((id) => {
      const comment = model.comments.find((candidate) => candidate.id === id)
      return !comment || Boolean(validateDocumentReviewCommentRecord(model, comment))
    })
  ) {
    return policyError('invalid-batch', 'The review batch record is invalid')
  }
  return undefined
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
