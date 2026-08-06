import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_REVIEW_LIMITS,
  applyDocumentReviewAction,
  createDocumentReviewModel,
  reviewCommentDeliveryEligibility,
  selectDocumentReviewComments,
  selectReviewBatchDocumentGroups,
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
  it('reduces rendered-block and source-range capture to the same source anchor', () => {
    const rendered = apply(
      emptyModel(),
      add(
        'rendered',
        'Rendered note',
        capture(document, original, 2, 2, 'rendered-block'),
      ),
    )
    const source = apply(
      emptyModel(),
      add('source', 'Source note', capture(document, original, 2, 2, 'source-range')),
    )

    expect(rendered.comments[0]?.anchor).toEqual(source.comments[0]?.anchor)
    expect(rendered.comments[0]).toMatchObject({
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

  it('requires an explicit stale review or re-anchor before delivery eligibility', () => {
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
    expect(batchMember(model).eligibility).toEqual({
      eligible: false,
      reason: 'stale-unreviewed',
    })
    expect(
      applyDocumentReviewAction(model, {
        type: 'mark-sent',
        workspace,
        commentIds: ['draft'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-comment' } })

    model = apply(model, { type: 'review-stale', workspace, commentId: 'draft' })
    expect(batchMember(model).eligibility).toEqual({ eligible: true })

    const reanchored = apply(
      apply(emptyModel(), add('draft', 'Check this', capture(document, original, 2))),
      {
        type: 'mark-document-stale',
        workspace,
        document,
        reason: 'deleted',
      },
    )
    expect(
      apply(reanchored, {
        type: 'reanchor-comment',
        workspace,
        commentId: 'draft',
        capture: capture(document, original, 1),
      }).comments[0]?.anchor.state,
    ).toEqual({ status: 'current' })
  })

  it('keeps anchor state orthogonal to deterministic draft, sent, and resolved history', () => {
    let model = apply(
      emptyModel(),
      add('lifecycle', 'Check this', capture(document, original, 2)),
    )
    expect(
      applyDocumentReviewAction(model, {
        type: 'resolve-comment',
        workspace,
        commentId: 'lifecycle',
      }),
    ).toMatchObject({ ok: false, error: { code: 'comment-not-sent' } })

    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'history',
      commentIds: ['lifecycle'],
    })
    model = apply(model, { type: 'mark-sent', workspace, commentIds: ['lifecycle'] })
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

    model = apply(model, {
      type: 'resolve-comment',
      workspace,
      commentId: 'lifecycle',
    })
    expect(model.comments[0]?.lifecycle).toBe('resolved')
    model = apply(model, { type: 'clear-history', workspace, history: 'resolved' })
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

  it('groups a bounded batch deterministically across Markdown documents in one workspace', () => {
    const alpha = localPath('/repo/a.md')
    const zeta = localPath('/repo/z.md')
    let model = emptyModel()
    model = apply(model, add('zeta', 'Last document', capture(zeta, 'one\ntwo\n', 2)))
    model = apply(model, add('alpha-late', 'Later line', capture(alpha, 'one\ntwo\n', 2)))
    model = apply(
      model,
      add('alpha-first', 'Earlier line', capture(alpha, 'one\ntwo\n', 1)),
    )
    model = apply(model, {
      type: 'create-batch',
      workspace,
      batchId: 'multi-document',
      commentIds: ['zeta', 'alpha-late', 'alpha-first'],
    })

    const groups = selectReviewBatchDocumentGroups(model, 'multi-document')
    expect(groups).toMatchObject({
      ok: true,
      value: [
        {
          relativePath: 'a.md',
          members: [
            { comment: { id: 'alpha-first' }, eligibility: { eligible: true } },
            { comment: { id: 'alpha-late' }, eligibility: { eligible: true } },
          ],
        },
        {
          relativePath: 'z.md',
          members: [{ comment: { id: 'zeta' }, eligibility: { eligible: true } }],
        },
      ],
    })
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
  representation: ReviewAnchorCapture['representation'] = 'source-range',
): ReviewAnchorCapture {
  return {
    representation,
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

function apply(
  model: DocumentReviewModel,
  action: DocumentReviewAction,
): DocumentReviewModel {
  const result = applyDocumentReviewAction(model, action)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.model
}

function batchMember(model: DocumentReviewModel) {
  const groups = selectReviewBatchDocumentGroups(model, 'batch')
  if (!groups.ok) throw new Error(groups.error.message)
  return groups.value[0]!.members[0]!
}
