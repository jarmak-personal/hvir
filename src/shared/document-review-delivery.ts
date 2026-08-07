import { containsHostPath, hostPathEquals } from './host-path'
import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewComment,
  type DocumentReviewDeliveryGroup,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliverySelection,
  type DocumentReviewModel,
} from './document-review'

const QUOTE_TRUNCATION_MARKER = '\n… [quote truncated]'

export type DocumentReviewDeliveryPolicyResult =
  | { readonly ok: true; readonly value: DocumentReviewDeliveryPayload }
  | { readonly ok: false; readonly error: string }

/** Pure owner for exact review selection, grouping, formatting, and outbound bounds. */
export function prepareDocumentReviewDeliveryPayload(
  model: DocumentReviewModel,
  selection: DocumentReviewDeliverySelection,
): DocumentReviewDeliveryPolicyResult {
  const selected = selectComments(model, selection)
  if (!selected.ok) return selected
  const comments = selected.value.toSorted(compareComments)
  const groups: DocumentReviewDeliveryGroup[] = []

  for (const comment of comments) {
    const relativePath = workspaceRelativePath(model, comment)
    if (!relativePath) {
      return failure('A review document is outside the exact workspace')
    }
    const body = normalizedTerminalText(comment.body)
    const excerpt = normalizedTerminalText(comment.anchor.excerpt)
    if (body === undefined || excerpt === undefined || unsafePath(relativePath)) {
      return failure('Review delivery refuses terminal control characters')
    }
    const quote = boundedQuote(excerpt)
    const prior = groups.at(-1)
    const member = {
      id: comment.id,
      range: comment.anchor.range,
      quote: quote.value,
      quoteTruncated: quote.truncated,
      comment: body,
    }
    if (prior?.relativePath === relativePath) {
      groups[groups.length - 1] = {
        ...prior,
        comments: [...prior.comments, member],
      }
    } else {
      groups.push({ relativePath, comments: [member] })
    }
  }

  const body = groups.map(formatGroup).join('\n\n')
  const byteLength = utf8Bytes(body)
  if (byteLength > DOCUMENT_REVIEW_LIMITS.deliveryPayloadBytes) {
    return failure('The review delivery exceeds its outbound byte limit')
  }
  return {
    ok: true,
    value: {
      body,
      byteLength,
      commentIds: comments.map((comment) => comment.id),
      groups,
    },
  }
}

function selectComments(
  model: DocumentReviewModel,
  selection: DocumentReviewDeliverySelection,
): { readonly ok: true; readonly value: readonly DocumentReviewComment[] } | {
  readonly ok: false
  readonly error: string
} {
  if (selection.kind === 'comment') {
    const comment = model.comments.find(({ id }) => id === selection.commentId)
    if (!comment) return failure('The review comment no longer exists')
    const eligibility = deliveryEligibility(model, comment)
    return eligibility ?? { ok: true, value: [comment] }
  }
  const batch = model.batches.find(({ id }) => id === selection.batchId)
  if (!batch || batch.commentIds.length === 0) {
    return failure('The review batch no longer exists')
  }
  if (
    batch.commentIds.length > DOCUMENT_REVIEW_LIMITS.batchMembers ||
    new Set(batch.commentIds).size !== batch.commentIds.length ||
    !workspaceEquals(model, batch.workspace)
  ) {
    return failure('The review batch is invalid')
  }
  const comments: DocumentReviewComment[] = []
  for (const id of batch.commentIds) {
    const comment = model.comments.find((candidate) => candidate.id === id)
    if (!comment) return failure('The review batch contains a missing comment')
    const eligibility = deliveryEligibility(model, comment)
    if (eligibility) return eligibility
    comments.push(comment)
  }
  return { ok: true, value: comments }
}

function deliveryEligibility(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): { readonly ok: false; readonly error: string } | undefined {
  if (
    !workspaceEquals(model, comment.workspace) ||
    !isWorkspaceDocument(model, comment) ||
    !validRange(comment) ||
    comment.id.length === 0 ||
    utf8Bytes(comment.id) > DOCUMENT_REVIEW_LIMITS.idBytes ||
    comment.body.trim().length === 0 ||
    utf8Bytes(comment.body) > DOCUMENT_REVIEW_LIMITS.commentBytes ||
    comment.anchor.excerpt.length === 0 ||
    utf8Bytes(comment.anchor.excerpt) > DOCUMENT_REVIEW_LIMITS.excerptBytes
  ) {
    return failure('The review comment is invalid')
  }
  if (comment.lifecycle !== 'draft') {
    return failure('Only draft review comments can be delivered')
  }
  if (comment.anchor.state.status === 'stale' && !comment.anchor.state.reviewed) {
    return failure('A stale review location must be acknowledged or re-anchored')
  }
  return undefined
}

function workspaceEquals(
  model: DocumentReviewModel,
  candidate: DocumentReviewComment['workspace'],
): boolean {
  return (
    model.workspace.id === candidate.id &&
    hostPathEquals(model.workspace.root, candidate.root)
  )
}

function isWorkspaceDocument(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): boolean {
  return (
    comment.document.hostId === model.workspace.root.hostId &&
    containsHostPath(model.workspace.root, comment.document) &&
    !hostPathEquals(model.workspace.root, comment.document) &&
    /\.(?:md|markdown)$/i.test(comment.document.path)
  )
}

function validRange(comment: DocumentReviewComment): boolean {
  const { startLine, endLine } = comment.anchor.range
  return (
    Number.isSafeInteger(startLine) &&
    Number.isSafeInteger(endLine) &&
    startLine >= 1 &&
    endLine >= startLine &&
    endLine - startLine + 1 <= DOCUMENT_REVIEW_LIMITS.sourceRangeLines
  )
}

function workspaceRelativePath(
  model: DocumentReviewModel,
  comment: DocumentReviewComment,
): string | undefined {
  if (!isWorkspaceDocument(model, comment)) return undefined
  return model.workspace.root.path === '/'
    ? comment.document.path.slice(1)
    : comment.document.path.slice(model.workspace.root.path.length + 1)
}

function compareComments(
  left: DocumentReviewComment,
  right: DocumentReviewComment,
): number {
  if (left.document.path !== right.document.path) {
    return left.document.path < right.document.path ? -1 : 1
  }
  return (
    left.anchor.range.startLine - right.anchor.range.startLine ||
    left.anchor.range.endLine - right.anchor.range.endLine ||
    left.id.localeCompare(right.id)
  )
}

function formatGroup(group: DocumentReviewDeliveryGroup): string {
  return group.comments
    .map(({ range, quote, comment }) => {
      const lines =
        range.startLine === range.endLine
          ? String(range.startLine)
          : `${range.startLine}-${range.endLine}`
      return `${group.relativePath}:${lines}\nQuote:\n${quote}\nComment:\n${comment}`
    })
    .join('\n\n')
}

function normalizedTerminalText(value: string): string | undefined {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return [...normalized].some((character) => {
    const code = character.codePointAt(0)!
    return (code < 32 && character !== '\n' && character !== '\t') || code === 127
  })
    ? undefined
    : normalized
}

function unsafePath(value: string): boolean {
  return value.length === 0 || [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || code === 127
  })
}

function boundedQuote(value: string): { readonly value: string; readonly truncated: boolean } {
  if (utf8Bytes(value) <= DOCUMENT_REVIEW_LIMITS.deliveryQuoteBytes) {
    return { value, truncated: false }
  }
  const budget = DOCUMENT_REVIEW_LIMITS.deliveryQuoteBytes - utf8Bytes(QUOTE_TRUNCATION_MARKER)
  let output = ''
  for (const character of value) {
    if (utf8Bytes(output) + utf8Bytes(character) > budget) break
    output += character
  }
  return { value: `${output}${QUOTE_TRUNCATION_MARKER}`, truncated: true }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function failure(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error }
}
