import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_REVIEW_LIMITS,
  applyDocumentReviewAction,
  createDocumentReviewModel,
  reviewCommentDeliveryEligibility,
  selectDocumentReviewComments,
  type DocumentReviewAction,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewAnchorCapture,
  type ReviewWorkspaceIdentity,
} from '../src/renderer/src/document-review'
import { asHostId, hostPath, localPath } from '../src/shared'

const workspace: ReviewWorkspaceIdentity = {
  id: 'project-1:worktree-main',
  root: localPath('/repo'),
}
const document = localPath('/repo/docs/review.md')
const original = 'intro\nTarget statement\noutro\n'

describe('document review model', () => {
  it('captures a representation-independent source anchor', () => {
    const model = apply(
      emptyModel(),
      add('source', 'Source note', capture(document, original, 2)),
    )

    expect(model.comments[0]).toMatchObject({
      workspace,
      document,
      lifecycle: 'draft',
      anchor: {
        range: { startLine: 2, endLine: 2 },
        excerpt: 'Target statement',
        contextBefore: 'intro\n',
        contextAfter: '\noutro',
        state: { status: 'current' },
      },
    })
  })

  it('atomically adds each new comment to the pending review batch', () => {
    let model = apply(emptyModel(), {
      ...add('first', 'First note', capture(document, original, 2)),
      batchId: 'active-review',
    })
    model = apply(model, {
      ...add('second', 'Second note', capture(document, original, 3)),
      batchId: 'active-review',
    })

    expect(model.batches).toEqual([
      {
        id: 'active-review',
        workspace,
        commentIds: ['first', 'second'],
      },
    ])
  })

  it('starts the next pending review without retaining sent batch members', () => {
    let model = apply(emptyModel(), {
      ...add('sent', 'Already sent', capture(document, original, 2)),
      batchId: 'active-review',
    })
    model = {
      ...model,
      comments: model.comments.map((comment) => ({
        ...comment,
        lifecycle: 'sent' as const,
      })),
    }

    model = apply(model, {
      ...add('next', 'Next review', capture(document, original, 3)),
      batchId: 'active-review',
    })

    expect(model.comments).toEqual([
      expect.objectContaining({ id: 'sent', lifecycle: 'sent' }),
      expect.objectContaining({ id: 'next', lifecycle: 'draft' }),
    ])
    expect(model.batches).toEqual([
      {
        id: 'active-review',
        workspace,
        commentIds: ['next'],
      },
    ])
  })

  it('fails closed across host, workspace identity, and workspace root', () => {
    const model = emptyModel()
    const otherWorkspace = { ...workspace, id: 'project-1:worktree-other' }
    const mismatched = applyDocumentReviewAction(model, {
      ...add('foreign-workspace', 'No', capture(document, original, 2)),
      workspace: otherWorkspace,
    })
    expect(mismatched).toMatchObject({
      ok: false,
      model,
      error: { code: 'workspace-mismatch' },
    })

    const remote = hostPath(asHostId('ssh:review'), '/repo/docs/review.md')
    expect(
      applyDocumentReviewAction(
        model,
        add('foreign-host', 'No', capture(remote, original, 2)),
      ),
    ).toMatchObject({ ok: false, model, error: { code: 'foreign-document' } })
    expect(
      applyDocumentReviewAction(
        model,
        add('outside', 'No', capture(localPath('/other/review.md'), original, 2)),
      ),
    ).toMatchObject({
      ok: false,
      model,
      error: { code: 'document-outside-workspace' },
    })
    expect(
      applyDocumentReviewAction(
        model,
        add('not-markdown', 'No', capture(localPath('/repo/readme.txt'), 'text\n', 1)),
      ),
    ).toMatchObject({ ok: false, model, error: { code: 'unsupported-document' } })

    const sshWorkspace: ReviewWorkspaceIdentity = {
      id: 'project-ssh:worktree-main',
      root: hostPath(asHostId('ssh:review'), '/repo'),
    }
    const sshModel = createDocumentReviewModel(sshWorkspace)
    if (!sshModel.ok) throw new Error(sshModel.error.message)
    expect(
      applyDocumentReviewAction(sshModel.value, {
        ...add('ssh', 'Remote review', capture(remote, original, 2)),
        workspace: sshWorkspace,
      }),
    ).toMatchObject({
      ok: true,
      model: { comments: [{ workspace: sshWorkspace, document: remote }] },
    })
  })

  it('moves only one exact excerpt-and-context match and retains the prior location', () => {
    let model = apply(
      emptyModel(),
      add('move', 'Check this', capture(document, original, 2)),
    )
    const movedContent = `preface\n${original}`
    model = apply(model, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(movedContent),
      content: movedContent,
    })

    expect(model.comments[0]?.anchor).toMatchObject({
      snapshot: snapshot(movedContent),
      range: { startLine: 3, endLine: 3 },
      state: {
        status: 'moved',
        previous: {
          snapshot: snapshot(original),
          range: { startLine: 2, endLine: 2 },
        },
      },
    })
  })

  it('marks missing and ambiguous exact matches stale without guessing', () => {
    const baseline = apply(
      emptyModel(),
      add('stale', 'Check this', capture(document, original, 2)),
    )
    const missingContent = 'intro\nChanged statement\noutro\n'
    const missing = apply(baseline, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(missingContent),
      content: missingContent,
    })
    expect(missing.comments[0]).toMatchObject({
      lifecycle: 'draft',
      anchor: {
        snapshot: snapshot(original),
        range: { startLine: 2, endLine: 2 },
        state: { status: 'stale', reason: 'missing-match', reviewed: false },
      },
    })

    const ambiguousContent = `${original}\n---\n${original}`
    const ambiguous = apply(baseline, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(ambiguousContent),
      content: ambiguousContent,
    })
    expect(ambiguous.comments[0]?.anchor.state).toEqual({
      status: 'stale',
      reason: 'ambiguous-match',
      reviewed: false,
    })

    const embeddedDecoy = `prefix ${original}${original}`
    const uniqueLineMatch = apply(baseline, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(embeddedDecoy),
      content: embeddedDecoy,
    })
    expect(uniqueLineMatch.comments[0]?.anchor.state.status).toBe('moved')
  })

  it('restores stale anchors when the exact anchored snapshot returns', () => {
    const baseline = apply(
      emptyModel(),
      add('restored', 'Check this', capture(document, original, 2)),
    )
    const missingContent = 'intro\nAltert statement\noutro\n'
    const missing = apply(baseline, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(missingContent),
      content: missingContent,
    })
    const ambiguousContent = `${original}\n---\n${original}`
    const ambiguous = apply(baseline, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(ambiguousContent),
      content: ambiguousContent,
    })
    const deleted = apply(baseline, {
      type: 'mark-document-stale',
      workspace,
      document,
      reason: 'deleted',
    })

    expect(missing.comments[0]?.anchor.state).toMatchObject({
      status: 'stale',
      reason: 'missing-match',
    })
    expect(ambiguous.comments[0]?.anchor.state).toMatchObject({
      status: 'stale',
      reason: 'ambiguous-match',
    })
    expect(deleted.comments[0]?.anchor.state).toMatchObject({
      status: 'stale',
      reason: 'deleted',
    })

    for (const stale of [missing, ambiguous, deleted]) {
      const restored = apply(stale, {
        type: 'revalidate-document',
        workspace,
        document,
        snapshot: snapshot(original),
        content: original,
      })
      expect(restored.comments[0]?.anchor).toMatchObject({
        snapshot: snapshot(original),
        range: { startLine: 2, endLine: 2 },
        state: { status: 'current' },
      })
    }
  })

  it('does not restore a stale anchor when the document bytes still differ', () => {
    const baseline = apply(
      emptyModel(),
      add('not-restored', 'Check this', capture(document, original, 2)),
    )
    const deleted = apply(baseline, {
      type: 'mark-document-stale',
      workspace,
      document,
      reason: 'deleted',
    })
    const differentContent = 'intro\nAltert statement\noutro\n'
    const stillStale = apply(deleted, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(original),
      content: differentContent,
    })

    expect(stillStale.comments[0]?.anchor).toMatchObject({
      snapshot: snapshot(original),
      range: { startLine: 2, endLine: 2 },
      state: { status: 'stale', reason: 'missing-match', reviewed: false },
    })
  })

  it('requires explicit acceptance before a stale comment becomes deliverable', () => {
    let model = apply(
      emptyModel(),
      add('draft', 'Check this', capture(document, original, 2)),
    )
    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'batch',
      commentIds: ['draft'],
    })
    model = apply(model, {
      type: 'mark-document-stale',
      workspace,
      document,
      reason: 'host-unavailable',
    })
    expect(reviewCommentDeliveryEligibility(model, model.comments[0]!)).toEqual({
      eligible: false,
      reason: 'stale-unreviewed',
    })

    model = apply(model, { type: 'review-stale', workspace, commentId: 'draft' })
    expect(reviewCommentDeliveryEligibility(model, model.comments[0]!)).toEqual({
      eligible: true,
    })
  })

  it('keeps anchor state orthogonal to deterministic draft and sent history', () => {
    let model = apply(
      emptyModel(),
      add('lifecycle', 'Check this', capture(document, original, 2)),
    )
    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'history',
      commentIds: ['lifecycle'],
    })
    model = {
      ...model,
      comments: model.comments.map((comment) => ({
        ...comment,
        lifecycle: 'sent' as const,
      })),
    }
    model = apply(model, {
      type: 'mark-document-stale',
      workspace,
      document,
      reason: 'deleted',
    })
    expect(model.comments[0]).toMatchObject({
      lifecycle: 'sent',
      anchor: { state: { status: 'stale' } },
    })
    expect(reviewCommentDeliveryEligibility(model, model.comments[0]!)).toEqual({
      eligible: false,
      reason: 'sent',
    })

    model = apply(model, { type: 'clear-history', workspace, history: 'sent' })
    expect(model.comments).toEqual([])
    expect(model.batches).toEqual([])
  })

  it('edits and removes only explicit drafts and cleans exact batch membership', () => {
    let model = apply(
      emptyModel(),
      add('first', 'Before', capture(document, original, 1)),
    )
    model = apply(model, add('second', 'Second', capture(document, original, 2)))
    model = apply(model, {
      type: 'edit-comment',
      workspace,
      commentId: 'first',
      body: 'After',
    })
    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'drafts',
      commentIds: ['first', 'second'],
    })
    model = apply(model, { type: 'remove-comment', workspace, commentId: 'first' })
    expect(model.comments.map((comment) => [comment.id, comment.body])).toEqual([
      ['second', 'Second'],
    ])
    expect(model.batches[0]?.commentIds).toEqual(['second'])

    model = apply(model, { type: 'remove-comment', workspace, commentId: 'second' })
    expect(model).toMatchObject({ comments: [], batches: [] })
  })

  it('rejects source, text, count, and batch bounds without truncation or partial changes', () => {
    const baseline = emptyModel()
    const tooLargeBody = 'x'.repeat(DOCUMENT_REVIEW_LIMITS.commentBytes + 1)
    expect(
      applyDocumentReviewAction(
        baseline,
        add('large', tooLargeBody, capture(document, original, 2)),
      ),
    ).toMatchObject({ ok: false, model: baseline, error: { code: 'text-too-large' } })
    expect(
      applyDocumentReviewAction(
        baseline,
        add('range', 'No', {
          ...capture(document, `${'line\n'.repeat(101)}end`, 1),
          range: { startLine: 1, endLine: 101 },
        }),
      ),
    ).toMatchObject({
      ok: false,
      model: baseline,
      error: { code: 'invalid-source-range' },
    })

    const excerptTooLarge = `${'x'.repeat(DOCUMENT_REVIEW_LIMITS.excerptBytes + 1)}\n`
    expect(
      applyDocumentReviewAction(
        baseline,
        add('excerpt', 'No', capture(document, excerptTooLarge, 1)),
      ),
    ).toMatchObject({
      ok: false,
      model: baseline,
      error: { code: 'anchor-excerpt-too-large' },
    })
    const contextTooLarge = `${'x'.repeat(DOCUMENT_REVIEW_LIMITS.contextBytes + 1)}\nTarget\n`
    expect(
      applyDocumentReviewAction(
        baseline,
        add('context', 'No', capture(document, contextTooLarge, 2)),
      ),
    ).toMatchObject({
      ok: false,
      model: baseline,
      error: { code: 'anchor-context-too-large' },
    })
    const mismatchedSnapshot = capture(document, original, 2)
    expect(
      applyDocumentReviewAction(baseline, {
        ...add('snapshot', 'No', mismatchedSnapshot),
        capture: {
          ...mismatchedSnapshot,
          snapshot: {
            ...mismatchedSnapshot.snapshot,
            byteLength: mismatchedSnapshot.snapshot.byteLength + 1,
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      model: baseline,
      error: { code: 'snapshot-mismatch' },
    })

    let model = baseline
    for (let index = 0; index < DOCUMENT_REVIEW_LIMITS.commentsPerDocument; index += 1) {
      model = apply(
        model,
        add(`comment-${index}`, `Comment ${index}`, capture(document, original, 2)),
      )
    }
    const documentLimited = applyDocumentReviewAction(
      model,
      add('one-too-many', 'No', capture(document, original, 2)),
    )
    expect(documentLimited).toMatchObject({
      ok: false,
      model,
      error: { code: 'document-comment-limit' },
    })

    model = apply(
      model,
      add('other-document', 'Other', capture(localPath('/repo/other.md'), 'Other\n', 1)),
    )
    expect(
      applyDocumentReviewAction(model, {
        type: 'create-batch',
        workspace,
        batchId: 'too-many',
        commentIds: model.comments.map((comment) => comment.id),
      }),
    ).toMatchObject({ ok: false, model, error: { code: 'batch-membership-limit' } })
  })

  it('enforces workspace comment and batch counts without changing rejected models', () => {
    expect(DOCUMENT_REVIEW_LIMITS.batchesPerWorkspace).toBe(1)
    let comments = emptyModel()
    for (let index = 0; index < DOCUMENT_REVIEW_LIMITS.commentsPerWorkspace; index += 1) {
      const path = localPath(`/repo/count-${index}.md`)
      comments = apply(
        comments,
        add(`count-${index}`, 'Comment', capture(path, 'Target\n', 1)),
      )
    }
    const commentLimited = applyDocumentReviewAction(
      comments,
      add(
        'count-overflow',
        'Comment',
        capture(localPath('/repo/count-overflow.md'), 'Target\n', 1),
      ),
    )
    expect(commentLimited).toMatchObject({
      ok: false,
      error: { code: 'comment-limit' },
    })
    expect(commentLimited.model).toBe(comments)

    let batches = apply(
      emptyModel(),
      add('member', 'Comment', capture(document, original, 2)),
    )
    for (let index = 0; index < DOCUMENT_REVIEW_LIMITS.batchesPerWorkspace; index += 1) {
      batches = apply(batches, {
        type: 'create-batch',
        workspace,
        batchId: `batch-${index}`,
        commentIds: ['member'],
      })
    }
    const batchLimited = applyDocumentReviewAction(batches, {
      type: 'create-batch',
      workspace,
      batchId: 'batch-overflow',
      commentIds: ['member'],
    })
    expect(batchLimited).toMatchObject({ ok: false, error: { code: 'batch-limit' } })
    expect(batchLimited.model).toBe(batches)
  })

  it('enforces exact identifier and workspace identity byte and control bounds', () => {
    const exactId = 'i'.repeat(DOCUMENT_REVIEW_LIMITS.idBytes)
    const accepted = applyDocumentReviewAction(
      emptyModel(),
      add(exactId, 'Comment', capture(document, original, 2)),
    )
    expect(accepted).toMatchObject({ ok: true, model: { comments: [{ id: exactId }] } })

    for (const [id, code] of [
      ['i'.repeat(DOCUMENT_REVIEW_LIMITS.idBytes + 1), 'id-too-large'],
      ['', 'invalid-id'],
      ['line\nbreak', 'invalid-id'],
    ] as const) {
      const model = emptyModel()
      const result = applyDocumentReviewAction(
        model,
        add(id, 'Comment', capture(document, original, 2)),
      )
      expect(result).toMatchObject({ ok: false, error: { code } })
      expect(result.model).toBe(model)
    }

    const exactWorkspace = createDocumentReviewModel({
      id: 'w'.repeat(DOCUMENT_REVIEW_LIMITS.workspaceIdBytes),
      root: localPath('/repo'),
    })
    expect(exactWorkspace).toMatchObject({ ok: true })
    for (const invalidWorkspaceId of [
      'w'.repeat(DOCUMENT_REVIEW_LIMITS.workspaceIdBytes + 1),
      'workspace\u0000id',
    ]) {
      expect(
        createDocumentReviewModel({ id: invalidWorkspaceId, root: localPath('/repo') }),
      ).toMatchObject({ ok: false, error: { code: 'invalid-workspace' } })
    }

    const model = apply(
      emptyModel(),
      add('member', 'Comment', capture(document, original, 2)),
    )
    for (const [batchId, code] of [
      ['b'.repeat(DOCUMENT_REVIEW_LIMITS.idBytes + 1), 'id-too-large'],
      ['bad\u007fid', 'invalid-id'],
    ] as const) {
      const result = applyDocumentReviewAction(model, {
        type: 'create-batch',
        workspace,
        batchId,
        commentIds: ['member'],
      })
      expect(result).toMatchObject({ ok: false, error: { code } })
      expect(result.model).toBe(model)
    }
  })

  it('applies revalidation over the storage bound while rejecting new authored data', () => {
    const model = modelAtStoredWorkspaceLimit()
    expect(storedBytes(model)).toBe(DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes)

    const authored = applyDocumentReviewAction(
      model,
      add(
        'new-authored-comment',
        'Comment',
        capture(localPath('/repo/new-authored.md'), 'Target\n', 1),
      ),
    )
    expect(authored).toMatchObject({
      ok: false,
      error: { code: 'stored-workspace-limit' },
    })
    expect(authored.model).toBe(model)

    const movedContent = `preface\n${original}`
    const moved = applyDocumentReviewAction(model, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(movedContent),
      content: movedContent,
    })
    expect(moved.ok).toBe(true)
    expect(
      moved.model.comments.find((comment) => comment.id === 'storage-target'),
    ).toMatchObject({
      anchor: { state: { status: 'moved' }, range: { startLine: 3 } },
    })
    expect(storedBytes(moved.model)).toBeGreaterThan(
      DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes,
    )

    const missingContent = 'intro\nChanged statement\noutro\n'
    const stale = applyDocumentReviewAction(model, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(missingContent),
      content: missingContent,
    })
    expect(stale.ok).toBe(true)
    expect(
      stale.model.comments.find((comment) => comment.id === 'storage-target'),
    ).toMatchObject({
      anchor: {
        state: { status: 'stale', reason: 'missing-match', reviewed: false },
      },
    })
    expect(storedBytes(stale.model)).toBeGreaterThan(
      DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes,
    )
  })

  it('short-circuits revalidation when digest and byte length are unchanged', () => {
    const model = apply(
      emptyModel(),
      add('unchanged', 'Comment', capture(document, original, 2)),
    )
    const result = applyDocumentReviewAction(model, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(original),
      content: 'deliberately unread and mismatched',
    })

    expect(result).toEqual({ ok: true, model })
    expect(result.model).toBe(model)
  })

  it('supports explicit active-batch membership without rechecking old members', () => {
    let model = apply(emptyModel(), add('first', 'First', capture(document, original, 1)))
    model = apply(
      model,
      add('second', 'Second', capture(localPath('/repo/second.md'), 'Second\n', 1)),
    )
    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'actions',
      commentIds: ['first'],
    })
    model = {
      ...model,
      comments: model.comments.map((comment) =>
        comment.id === 'first' ? { ...comment, lifecycle: 'sent' as const } : comment,
      ),
    }
    model = apply(model, {
      type: 'add-to-batch',
      workspace,
      batchId: 'actions',
      commentId: 'second',
    })
    expect(model.batches[0]?.commentIds).toEqual(['first', 'second'])

    const duplicate = applyDocumentReviewAction(model, {
      type: 'add-to-batch',
      workspace,
      batchId: 'actions',
      commentId: 'second',
    })
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'duplicate-member' } })
    expect(duplicate.model).toBe(model)

    model = apply(model, {
      type: 'remove-from-batch',
      workspace,
      batchId: 'actions',
      commentId: 'second',
    })
    const missing = applyDocumentReviewAction(model, {
      type: 'remove-from-batch',
      workspace,
      batchId: 'actions',
      commentId: 'second',
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'unknown-comment' } })
    expect(missing.model).toBe(model)

    model = apply(model, {
      type: 'remove-from-batch',
      workspace,
      batchId: 'actions',
      commentId: 'first',
    })
    expect(model.batches).toEqual([])
  })

  it('turns an over-limit revalidation read into visible stale state', () => {
    const model = apply(
      emptyModel(),
      add('bounded-read', 'Check', capture(document, original, 2)),
    )
    const oversized = 'x'.repeat(DOCUMENT_REVIEW_LIMITS.revalidationReadBytes + 1)
    const stale = apply(model, {
      type: 'revalidate-document',
      workspace,
      document,
      snapshot: snapshot(oversized),
      content: oversized,
    })

    expect(stale.comments[0]?.anchor).toMatchObject({
      snapshot: snapshot(original),
      state: { status: 'stale', reason: 'read-limit-exceeded', reviewed: false },
    })
  })

  it('keeps hostile text literal and rejects malformed restored records from eligibility', () => {
    const hostile =
      '```html\n<script>globalThis.pwned = true</script>\n```\n${notInterpolation}.*'
    const model = apply(
      emptyModel(),
      add('hostile', hostile, capture(document, 'before\n.*${literal}\nafter\n', 2)),
    )
    expect(model.comments[0]?.body).toBe(hostile)
    expect(model.comments[0]?.anchor.excerpt).toBe('.*${literal}')
    expect(reviewCommentDeliveryEligibility(model, model.comments[0]!)).toEqual({
      eligible: true,
    })

    const malformed: DocumentReviewComment = {
      ...model.comments[0]!,
      body: '   ',
    }
    expect(reviewCommentDeliveryEligibility(model, malformed)).toEqual({
      eligible: false,
      reason: 'invalid-record',
    })
  })

  it('selects document comments at the host-qualified owner seam', () => {
    const model = apply(emptyModel(), add('one', 'Note', capture(document, original, 2)))
    expect(selectDocumentReviewComments(model, document)).toMatchObject({
      ok: true,
      value: [{ id: 'one' }],
    })
    expect(
      selectDocumentReviewComments(model, localPath('/outside/review.md')),
    ).toMatchObject({
      ok: false,
      error: { code: 'document-outside-workspace' },
    })
  })
})

function emptyModel(): DocumentReviewModel {
  const result = createDocumentReviewModel(workspace)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function add(
  commentId: string,
  body: string,
  anchorCapture: ReviewAnchorCapture,
): Extract<DocumentReviewAction, { readonly type: 'add-comment' }> {
  return {
    type: 'add-comment',
    workspace,
    commentId,
    body,
    capture: anchorCapture,
  }
}

function capture(
  path: ReviewAnchorCapture['document'],
  content: string,
  startLine: number,
  endLine = startLine,
): ReviewAnchorCapture {
  return {
    document: path,
    snapshot: snapshot(content),
    content,
    range: { startLine, endLine },
  }
}

function snapshot(content: string): ReviewAnchorCapture['snapshot'] {
  return {
    algorithm: 'sha256',
    digest: createHash('sha256').update(content).digest('hex'),
    byteLength: Buffer.byteLength(content, 'utf8'),
  }
}

function modelAtStoredWorkspaceLimit(): DocumentReviewModel {
  let model = apply(
    emptyModel(),
    add('storage-target', 'Target', capture(document, original, 2)),
  )
  model = apply(
    model,
    add(
      'storage-padding',
      'P',
      capture(localPath('/repo/storage-padding.md'), 'Padding\n', 1),
    ),
  )
  const template = model.comments[0]!

  for (
    let index = 0;
    model.comments.length < DOCUMENT_REVIEW_LIMITS.commentsPerWorkspace;
    index += 1
  ) {
    const filler: DocumentReviewComment = {
      ...template,
      id: `storage-filler-${index}`,
      document: localPath(`/repo/storage-filler-${index}.md`),
      body: 'x'.repeat(DOCUMENT_REVIEW_LIMITS.commentBytes),
    }
    const candidate = { ...model, comments: [...model.comments, filler] }
    if (storedBytes(candidate) > DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes) break
    model = candidate
  }

  let remaining = DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes - storedBytes(model)
  for (const id of ['storage-target', 'storage-padding']) {
    const comment = model.comments.find((candidate) => candidate.id === id)!
    const capacity = DOCUMENT_REVIEW_LIMITS.commentBytes - Buffer.byteLength(comment.body)
    const addition = Math.min(remaining, capacity)
    if (addition === 0) continue
    model = {
      ...model,
      comments: model.comments.map((candidate) =>
        candidate.id === id
          ? { ...candidate, body: `${candidate.body}${'x'.repeat(addition)}` }
          : candidate,
      ),
    }
    remaining -= addition
  }
  if (remaining !== 0) throw new Error('Could not construct a storage-bound model')
  return model
}

function storedBytes(model: DocumentReviewModel): number {
  return Buffer.byteLength(JSON.stringify(model), 'utf8')
}

function apply(
  model: DocumentReviewModel,
  action: DocumentReviewAction,
): DocumentReviewModel {
  const result = applyDocumentReviewAction(model, action)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.model
}
