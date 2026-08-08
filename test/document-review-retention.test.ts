import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_REVIEW_DRAFT_RETENTION_MS,
  expireDocumentReviewDrafts,
  initialDocumentReviewDraftActivity,
  reconcileDocumentReviewDraftActivity,
} from '../src/main/document-review/document-review-retention'
import { localPath, type DocumentReviewModel } from '../src/shared'

const workspace = { id: 'review-workspace', root: localPath('/repo') }

describe('document review draft retention', () => {
  it('tracks only drafts and refreshes activity only for creation or body edits', () => {
    const initial = model()
    const activity = initialDocumentReviewDraftActivity(initial, 100)
    expect(activity).toEqual([{ commentId: 'draft', updatedAt: 100 }])

    const revalidated: DocumentReviewModel = {
      ...initial,
      comments: initial.comments.map((comment) =>
        comment.id === 'draft'
          ? { ...comment, anchor: { ...comment.anchor, state: { status: 'current' } } }
          : comment,
      ),
    }
    expect(
      reconcileDocumentReviewDraftActivity(
        { model: initial, draftActivity: activity },
        revalidated,
        200,
      ),
    ).toEqual(activity)

    const edited: DocumentReviewModel = {
      ...revalidated,
      comments: revalidated.comments.map((comment) =>
        comment.id === 'draft' ? { ...comment, body: 'Edited feedback' } : comment,
      ),
    }
    expect(
      reconcileDocumentReviewDraftActivity(
        { model: revalidated, draftActivity: activity },
        edited,
        200,
      ),
    ).toEqual([{ commentId: 'draft', updatedAt: 200 }])
  })

  it('expires drafts at seven days while preserving legacy history and batch integrity', () => {
    const current = model()
    const beforeBoundary = expireDocumentReviewDrafts(
      current,
      [{ commentId: 'draft', updatedAt: 1_000 }],
      1_000 + DOCUMENT_REVIEW_DRAFT_RETENTION_MS - 1,
    )
    expect(beforeBoundary.changed).toBe(false)
    expect(beforeBoundary.model).toBe(current)

    const expired = expireDocumentReviewDrafts(
      current,
      [{ commentId: 'draft', updatedAt: 1_000 }],
      1_000 + DOCUMENT_REVIEW_DRAFT_RETENTION_MS,
    )
    expect(expired).toMatchObject({
      changed: true,
      draftActivity: [],
      model: {
        comments: [{ id: 'sent', lifecycle: 'sent' }],
        batches: [],
      },
    })
  })
})

function model(): DocumentReviewModel {
  const draft = comment('draft', 'draft')
  return {
    workspace,
    comments: [draft, comment('sent', 'sent')],
    batches: [{ id: 'active-review', workspace, commentIds: [draft.id] }],
  }
}

function comment(
  id: string,
  lifecycle: 'draft' | 'sent',
): DocumentReviewModel['comments'][number] {
  return {
    id,
    workspace,
    document: localPath('/repo/readme.md'),
    body: `${id} feedback`,
    lifecycle,
    anchor: {
      snapshot: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        byteLength: 6,
      },
      range: { startLine: 1, endLine: 1 },
      excerpt: '# Test',
      contextBefore: '',
      contextAfter: '',
      state: { status: 'current' },
    },
  }
}
