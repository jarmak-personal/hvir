import {
  DOCUMENT_REVIEW_LIMITS,
  type DocumentReviewAnchor,
  type ReviewAnchorCapture,
  type ReviewAnchorStaleReason,
  type ReviewDocumentSnapshot,
  type ReviewPolicyError,
  type ReviewPolicyResult,
  type ReviewSourceRange,
} from './document-review-types'
import {
  reviewPolicyError,
  reviewPolicyFailure,
  reviewPolicySuccess,
  reviewUtf8Bytes,
} from './document-review-validation'

const SHA256_DIGEST = /^[a-f0-9]{64}$/

interface SourceLineSpan {
  readonly start: number
  /** End excludes the line delimiter, including the carriage return in CRLF. */
  readonly end: number
}

export function captureDocumentReviewAnchor(
  capture: ReviewAnchorCapture,
): ReviewPolicyResult<DocumentReviewAnchor> {
  const snapshotError = validateSnapshot(capture.snapshot, capture.content)
  if (snapshotError) return reviewPolicyFailure(snapshotError)
  if (reviewUtf8Bytes(capture.content) > DOCUMENT_REVIEW_LIMITS.revalidationReadBytes) {
    return reviewPolicyFailure(
      reviewPolicyError(
        'read-limit-exceeded',
        'The document exceeds the review read limit',
      ),
    )
  }

  const lines = sourceLineSpans(capture.content)
  const rangeError = validateRange(capture.range, lines.length)
  if (rangeError) return reviewPolicyFailure(rangeError)
  const first = lines[capture.range.startLine - 1]!
  const last = lines[capture.range.endLine - 1]!
  const excerpt = capture.content.slice(first.start, last.end)
  if (excerpt.length === 0) {
    return reviewPolicyFailure(
      reviewPolicyError('empty-excerpt', 'A review anchor must contain source text'),
    )
  }
  if (reviewUtf8Bytes(excerpt) > DOCUMENT_REVIEW_LIMITS.excerptBytes) {
    return reviewPolicyFailure(
      reviewPolicyError(
        'anchor-excerpt-too-large',
        'The selected source exceeds the anchor limit',
      ),
    )
  }

  const previous = lines[capture.range.startLine - 2]
  const next = lines[capture.range.endLine]
  const contextBefore = previous ? capture.content.slice(previous.start, first.start) : ''
  const contextAfter = next ? capture.content.slice(last.end, next.end) : ''
  if (
    reviewUtf8Bytes(contextBefore) > DOCUMENT_REVIEW_LIMITS.contextBytes ||
    reviewUtf8Bytes(contextAfter) > DOCUMENT_REVIEW_LIMITS.contextBytes
  ) {
    return reviewPolicyFailure(
      reviewPolicyError(
        'anchor-context-too-large',
        'An adjacent source line exceeds the anchor context limit',
      ),
    )
  }

  return reviewPolicySuccess({
    snapshot: capture.snapshot,
    range: capture.range,
    excerpt,
    contextBefore,
    contextAfter,
    state: { status: 'current' },
  })
}

export function revalidateDocumentReviewAnchor(
  anchor: DocumentReviewAnchor,
  snapshot: ReviewDocumentSnapshot,
  content: string,
): DocumentReviewAnchor {
  if (snapshotEquals(anchor.snapshot, snapshot)) return anchor
  if (reviewUtf8Bytes(content) > DOCUMENT_REVIEW_LIMITS.revalidationReadBytes) {
    return staleDocumentReviewAnchor(anchor, 'read-limit-exceeded')
  }
  if (validateSnapshot(snapshot, content)) {
    return staleDocumentReviewAnchor(anchor, 'invalid-snapshot')
  }

  const pattern = `${anchor.contextBefore}${anchor.excerpt}${anchor.contextAfter}`
  const matches = exactMatchOffsets(content, pattern)
  if (matches.length === 0) return staleDocumentReviewAnchor(anchor, 'missing-match')
  if (matches.length > 1) return staleDocumentReviewAnchor(anchor, 'ambiguous-match')

  const excerptOffset = matches[0]! + anchor.contextBefore.length
  const nextRange = rangeAtOffset(content, excerptOffset, anchor.excerpt)
  const moved = !sourceRangeEquals(anchor.range, nextRange)
  return {
    ...anchor,
    snapshot,
    range: nextRange,
    state: moved
      ? {
          status: 'moved',
          previous: { snapshot: anchor.snapshot, range: anchor.range },
        }
      : anchor.state.status === 'moved'
        ? { status: 'moved', previous: anchor.state.previous }
        : { status: 'current' },
  }
}

export function staleDocumentReviewAnchor(
  anchor: DocumentReviewAnchor,
  reason: ReviewAnchorStaleReason,
): DocumentReviewAnchor {
  return { ...anchor, state: { status: 'stale', reason, reviewed: false } }
}

export function validateDocumentReviewAnchor(
  anchor: DocumentReviewAnchor,
): ReviewPolicyError | undefined {
  const snapshotError = validateSnapshotShape(anchor.snapshot)
  if (snapshotError) return reviewPolicyError('invalid-anchor', snapshotError.message)
  const rangeError = validateRange(anchor.range)
  if (rangeError) return reviewPolicyError('invalid-anchor', rangeError.message)
  if (anchor.excerpt.length === 0) {
    return reviewPolicyError(
      'invalid-anchor',
      'A persisted review anchor has an empty excerpt',
    )
  }
  if (
    reviewUtf8Bytes(anchor.excerpt) > DOCUMENT_REVIEW_LIMITS.excerptBytes ||
    reviewUtf8Bytes(anchor.contextBefore) > DOCUMENT_REVIEW_LIMITS.contextBytes ||
    reviewUtf8Bytes(anchor.contextAfter) > DOCUMENT_REVIEW_LIMITS.contextBytes
  ) {
    return reviewPolicyError(
      'invalid-anchor',
      'A persisted review anchor exceeds its text bounds',
    )
  }
  if (anchor.state.status === 'moved') {
    const previousSnapshotError = validateSnapshotShape(anchor.state.previous.snapshot)
    const previousRangeError = validateRange(anchor.state.previous.range)
    if (previousSnapshotError || previousRangeError) {
      return reviewPolicyError(
        'invalid-anchor',
        'A moved review anchor has an invalid prior location',
      )
    }
  }
  return undefined
}

export function sourceRangeEquals(
  left: ReviewSourceRange,
  right: ReviewSourceRange,
): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine
}

function validateSnapshot(
  snapshot: ReviewDocumentSnapshot,
  content: string,
): ReviewPolicyError | undefined {
  const shapeError = validateSnapshotShape(snapshot)
  if (shapeError) return shapeError
  if (snapshot.byteLength !== reviewUtf8Bytes(content)) {
    return reviewPolicyError(
      'snapshot-mismatch',
      'The snapshot byte length does not match the on-disk content',
    )
  }
  return undefined
}

function validateSnapshotShape(
  snapshot: ReviewDocumentSnapshot,
): ReviewPolicyError | undefined {
  if (
    snapshot.algorithm !== 'sha256' ||
    !SHA256_DIGEST.test(snapshot.digest) ||
    !Number.isSafeInteger(snapshot.byteLength) ||
    snapshot.byteLength < 0
  ) {
    return reviewPolicyError(
      'snapshot-mismatch',
      'The on-disk snapshot identity is invalid',
    )
  }
  return undefined
}

function validateRange(
  range: ReviewSourceRange,
  lineCount?: number,
): ReviewPolicyError | undefined {
  const length = range.endLine - range.startLine + 1
  if (
    !Number.isSafeInteger(range.startLine) ||
    !Number.isSafeInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine ||
    length > DOCUMENT_REVIEW_LIMITS.sourceRangeLines ||
    (lineCount !== undefined && range.endLine > lineCount)
  ) {
    return reviewPolicyError(
      'invalid-source-range',
      'Review source ranges must be bounded, inclusive, and inside the document',
    )
  }
  return undefined
}

function sourceLineSpans(content: string): readonly SourceLineSpan[] {
  const lines: SourceLineSpan[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue
    const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    lines.push({ start, end })
    start = index + 1
  }
  lines.push({ start, end: content.length })
  return lines
}

function exactMatchOffsets(content: string, pattern: string): readonly number[] {
  const matches: number[] = []
  let offset = content.indexOf(pattern)
  while (offset !== -1 && matches.length < 2) {
    const end = offset + pattern.length
    const startsOnLine = offset === 0 || content.charCodeAt(offset - 1) === 10
    const endsOnLine =
      end === content.length ||
      content.charCodeAt(end) === 10 ||
      (content.charCodeAt(end) === 13 && content.charCodeAt(end + 1) === 10)
    if (startsOnLine && endsOnLine) matches.push(offset)
    offset = content.indexOf(pattern, offset + 1)
  }
  return matches
}

function rangeAtOffset(
  content: string,
  excerptOffset: number,
  excerpt: string,
): ReviewSourceRange {
  let startLine = 1
  for (let index = 0; index < excerptOffset; index += 1) {
    if (content.charCodeAt(index) === 10) startLine += 1
  }
  let endLine = startLine
  for (let index = 0; index < excerpt.length; index += 1) {
    if (excerpt.charCodeAt(index) === 10) endLine += 1
  }
  return { startLine, endLine }
}

function snapshotEquals(
  left: ReviewDocumentSnapshot,
  right: ReviewDocumentSnapshot,
): boolean {
  return left.digest === right.digest && left.byteLength === right.byteLength
}
