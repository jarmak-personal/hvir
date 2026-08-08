import { describe, expect, it } from 'vitest'

import { prepareDocumentReviewDeliveryPayload } from '../src/main/document-review/document-review-delivery-policy'
import {
  DOCUMENT_REVIEW_LIMITS,
  localPath,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const workspace: ReviewWorkspaceIdentity = {
  id: 'project:main',
  root: localPath('/repo'),
}

describe('document review delivery policy', () => {
  it('formats one immutable LF body grouped deterministically by relative path and line', () => {
    const model = {
      ...modelWith([
        comment('third', '/repo/docs/z.md', 3, 'third quote', 'Third\r\ncomment'),
        comment('second', '/repo/docs/a.md', 9, 'second quote', 'Second comment'),
        comment('first', '/repo/docs/a.md', 2, 'first\r\nquote', 'First comment'),
        comment(
          'excluded',
          '/repo/docs/other.md',
          1,
          'unselected source',
          'clipboard-secret',
        ),
      ]),
      batches: [
        {
          id: 'review',
          workspace,
          commentIds: ['third', 'second', 'first'],
        },
      ],
    }

    const prepared = prepareDocumentReviewDeliveryPayload(model, {
      kind: 'batch',
      batchId: 'review',
    })
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        body:
          'User feedback/review on document docs/a.md\n\n' +
          'docs/a.md:2\nQuote:\nfirst\nquote\nComment:\nFirst comment\n\n' +
          'docs/a.md:9\nQuote:\nsecond quote\nComment:\nSecond comment\n\n' +
          'User feedback/review on document docs/z.md\n\n' +
          'docs/z.md:3\nQuote:\nthird quote\nComment:\nThird\ncomment',
        commentIds: ['first', 'second', 'third'],
      },
    })
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.value.byteLength).toBe(
      new TextEncoder().encode(prepared.value.body).byteLength,
    )
    expect(new TextDecoder().decode(new TextEncoder().encode(prepared.value.body))).toBe(
      prepared.value.body,
    )
    expect(prepared.value.body).not.toContain('clipboard-secret')
    expect(prepared.value.body).not.toContain('/repo/docs/a.md')
  })

  it('uses the same batch-of-one contract and visibly truncates only the quote', () => {
    const source = 'é'.repeat(DOCUMENT_REVIEW_LIMITS.deliveryQuoteBytes)
    const review = comment('one', '/repo/README.md', 4, source, 'Keep this exact')
    const prepared = prepareDocumentReviewDeliveryPayload(modelWith([review]), {
      kind: 'comment',
      commentId: review.id,
    })
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        commentIds: ['one'],
      },
    })
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.value.body).toContain('… [quote truncated]')
    expect(prepared.value.body).toContain('Comment:\nKeep this exact')
  })

  it('fails closed for ineligible records and unsafe terminal text without dropping members', () => {
    const stale = {
      ...comment('stale', '/repo/a.md', 1, 'quote', 'stale'),
      anchor: {
        ...comment('stale', '/repo/a.md', 1, 'quote', 'stale').anchor,
        state: { status: 'stale', reason: 'missing-match', reviewed: false } as const,
      },
    }
    const sent = {
      ...comment('sent', '/repo/b.md', 1, 'quote', 'sent'),
      lifecycle: 'sent' as const,
    }
    const model = {
      ...modelWith([stale, sent]),
      batches: [{ id: 'blocked', workspace, commentIds: ['stale', 'sent'] }],
    }
    const blocked = prepareDocumentReviewDeliveryPayload(model, {
      kind: 'batch',
      batchId: 'blocked',
    })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) throw new Error('Expected a blocked batch')
    expect(blocked.error).toMatch(/stale/)
    expect(model.batches[0]?.commentIds).toEqual(['stale', 'sent'])

    const unsafe = modelWith([
      comment('unsafe', '/repo/a.md', 1, 'quote', 'do not emit\u001b[31m'),
    ])
    const unsafeResult = prepareDocumentReviewDeliveryPayload(unsafe, {
      kind: 'comment',
      commentId: 'unsafe',
    })
    expect(unsafeResult.ok).toBe(false)
    if (unsafeResult.ok) throw new Error('Expected unsafe terminal text to fail')
    expect(unsafeResult.error).toMatch(/control/)
  })

  it('refuses an over-limit complete batch rather than truncating comments or membership', () => {
    const comments = Array.from(
      { length: DOCUMENT_REVIEW_LIMITS.batchMembers },
      (_, index) =>
        comment(
          `comment-${index}`,
          `/repo/review-${index}.md`,
          1,
          'q',
          'x'.repeat(1_100),
        ),
    )
    const model = {
      ...modelWith(comments),
      batches: [{ id: 'large', workspace, commentIds: comments.map(({ id }) => id) }],
    }
    const prepared = prepareDocumentReviewDeliveryPayload(model, {
      kind: 'batch',
      batchId: 'large',
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) throw new Error('Expected the oversized batch to fail')
    expect(prepared.error).toMatch(/outbound byte limit/)
    expect(model.batches[0]?.commentIds).toHaveLength(DOCUMENT_REVIEW_LIMITS.batchMembers)
  })
})

function modelWith(comments: readonly DocumentReviewComment[]): DocumentReviewModel {
  return { workspace, comments: [...comments], batches: [] }
}

function comment(
  id: string,
  path: string,
  line: number,
  excerpt: string,
  body: string,
): DocumentReviewComment {
  return {
    id,
    workspace,
    document: localPath(path),
    body,
    lifecycle: 'draft',
    anchor: {
      snapshot: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        byteLength: new TextEncoder().encode(excerpt).byteLength,
      },
      range: { startLine: line, endLine: line },
      excerpt,
      contextBefore: '',
      contextAfter: '',
      state: { status: 'current' },
    },
  }
}
