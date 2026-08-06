import type { HostPath } from '../../../shared'
import type {
  ReviewAnchorCapture,
  ReviewDocumentSnapshot,
  ReviewSourceRange,
} from './document-review-types'

export async function createDocumentReviewCapture(
  document: HostPath,
  content: string,
  range: ReviewSourceRange,
): Promise<ReviewAnchorCapture> {
  return {
    document,
    content,
    range,
    snapshot: await createDocumentReviewSnapshot(content),
  }
}

export async function createDocumentReviewSnapshot(
  content: string,
): Promise<ReviewDocumentSnapshot> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    algorithm: 'sha256',
    digest: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    byteLength: bytes.byteLength,
  }
}
