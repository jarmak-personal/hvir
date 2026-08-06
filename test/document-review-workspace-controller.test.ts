import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  DocumentReviewWorkspaceController,
  documentReviewPaths,
  type DocumentReviewWorkspacePort,
  type DocumentReviewWorkspaceState,
} from '../src/renderer/src/document-review/document-review-workspace-controller'
import type {
  DocumentReviewAction,
  DocumentReviewModel,
} from '../src/renderer/src/document-review/document-review-types'
import {
  localPath,
  type DocumentReviewRevalidation,
  type DocumentReviewWorkspaceSnapshot,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const workspaceA: ReviewWorkspaceIdentity = { id: 'a', root: localPath('/a') }
const workspaceB: ReviewWorkspaceIdentity = { id: 'b', root: localPath('/b') }
const documentA = localPath('/a/review.md')
const content = 'before\ntarget\nafter\n'

describe('document review workspace controller', () => {
  it('deactivates retained state and rejects late restore completions', async () => {
    const restoreA = deferred<DocumentReviewWorkspaceSnapshot>()
    const restoreB = deferred<DocumentReviewWorkspaceSnapshot>()
    const fixture = createFixture({
      restore: vi.fn((workspace: ReviewWorkspaceIdentity) =>
        workspace.id === 'a' ? restoreA.promise : restoreB.promise,
      ),
    })

    fixture.controller.activate(workspaceA)
    fixture.controller.deactivate()
    restoreA.resolve(stored(workspaceA, 1, modelWithComment(workspaceA, documentA)))
    await settle()
    expect(fixture.controller.snapshot()).toMatchObject({ status: 'idle', revision: 0 })
    expect(documentReviewPaths(fixture.controller.snapshot().model)).toEqual([])

    fixture.controller.activate(workspaceA)
    fixture.controller.activate(workspaceB)
    restoreB.resolve(stored(workspaceB, 2, emptyModel(workspaceB)))
    await settle()
    expect(fixture.controller.snapshot()).toMatchObject({
      status: 'ready',
      workspace: workspaceB,
      revision: 2,
    })
  })

  it('applies immediately while saving edits in revision order', async () => {
    const firstSave = deferred<DocumentReviewWorkspaceSnapshot>()
    const secondSave = deferred<DocumentReviewWorkspaceSnapshot>()
    const save = vi
      .fn<DocumentReviewWorkspacePort['save']>()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
    const fixture = createFixture({ save })
    fixture.controller.activate(workspaceA)
    await settle()

    expect(fixture.controller.apply(add('one', 'First'))).toMatchObject({ ok: true })
    expect(fixture.controller.apply(add('two', 'Second'))).toMatchObject({ ok: true })
    expect(fixture.controller.snapshot().model?.comments).toHaveLength(2)
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 0 })

    firstSave.resolve(stored(workspaceA, 1, save.mock.calls[0]![0].model))
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 1 })
    secondSave.resolve(stored(workspaceA, 2, save.mock.calls[1]![0].model))
    await fixture.controller.flush()
    expect(fixture.controller.snapshot()).toMatchObject({ revision: 2, error: undefined })
  })

  it('flushes the old save tail before restoring a switched workspace', async () => {
    const saving = deferred<DocumentReviewWorkspaceSnapshot>()
    const restore = vi.fn((workspace: ReviewWorkspaceIdentity) =>
      Promise.resolve(stored(workspace, 0, emptyModel(workspace))),
    )
    const fixture = createFixture({ restore, save: vi.fn(() => saving.promise) })
    fixture.controller.activate(workspaceA)
    await settle()
    fixture.controller.apply(add('switch-save', 'Save before switching'))
    await settle()

    fixture.controller.activate(workspaceB)
    expect(fixture.controller.snapshot()).toMatchObject({
      status: 'loading',
      workspace: workspaceB,
    })
    expect(restore).toHaveBeenCalledTimes(1)

    saving.resolve(stored(workspaceA, 1, modelWithComment(workspaceA, documentA)))
    await fixture.controller.flush()
    await settle()
    expect(restore).toHaveBeenCalledTimes(2)
    expect(fixture.controller.snapshot()).toMatchObject({
      status: 'ready',
      workspace: workspaceB,
    })
  })

  it('finishes an in-flight save before disposal invalidates its generation', async () => {
    const saving = deferred<DocumentReviewWorkspaceSnapshot>()
    const save = vi.fn<DocumentReviewWorkspacePort['save']>(() => saving.promise)
    const fixture = createFixture({ save })
    fixture.controller.activate(workspaceA)
    await settle()
    fixture.controller.apply(add('unmount-save', 'Save before unmount'))
    fixture.controller.dispose()
    expect(save).toHaveBeenCalledOnce()

    saving.resolve(stored(workspaceA, 1, save.mock.calls[0]![0].model))
    await fixture.controller.flush()
    await settle()
    expect(fixture.controller.snapshot()).toMatchObject({ status: 'idle' })
  })

  it('revokes late revalidation and marks unlink without rereading', async () => {
    const revalidation = deferred<DocumentReviewRevalidation>()
    const revalidate = vi.fn(() => revalidation.promise)
    const fixture = createFixture({
      restore: vi.fn((workspace: ReviewWorkspaceIdentity) =>
        Promise.resolve(
          workspace.id === 'a'
            ? stored(workspace, 0, modelWithComment(workspace, documentA))
            : stored(workspace, 0, emptyModel(workspace)),
        ),
      ),
      revalidate,
    })
    fixture.controller.activate(workspaceA)
    await settle()
    fixture.controller.handleWatch({ type: 'change', path: documentA })
    expect(revalidate).toHaveBeenCalledOnce()

    fixture.controller.activate(workspaceB)
    revalidation.resolve({
      status: 'stale',
      document: documentA,
      reason: 'deleted',
    })
    await settle()
    expect(fixture.controller.snapshot()).toMatchObject({
      status: 'ready',
      workspace: workspaceB,
      model: { comments: [] },
    })

    fixture.controller.activate(workspaceA)
    await settle()
    fixture.controller.handleWatch({ type: 'unlink', path: documentA })
    expect(fixture.controller.snapshot().model?.comments[0]?.anchor.state).toEqual({
      status: 'stale',
      reason: 'deleted',
      reviewed: false,
    })
    expect(revalidate).toHaveBeenCalledOnce()
  })
})

function createFixture(overrides: Partial<DocumentReviewWorkspacePort> = {}) {
  const states: DocumentReviewWorkspaceState[] = []
  const port: DocumentReviewWorkspacePort = {
    restore: (workspace) => Promise.resolve(stored(workspace, 0, emptyModel(workspace))),
    save: (request) =>
      Promise.resolve(
        stored(request.workspace, request.expectedRevision + 1, request.model),
      ),
    revalidate: (request) =>
      Promise.resolve({
        status: 'stale',
        document: request.document,
        reason: 'host-unavailable',
      }),
    ...overrides,
  }
  const controller = new DocumentReviewWorkspaceController(port, (state) =>
    states.push(state),
  )
  return { controller, port, states }
}

function stored(
  _workspace: ReviewWorkspaceIdentity,
  revision: number,
  model: DocumentReviewModel,
): DocumentReviewWorkspaceSnapshot {
  return { workspaceGeneration: 7, revision, model }
}

function emptyModel(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  return { workspace, comments: [], batches: [] }
}

function modelWithComment(
  workspace: ReviewWorkspaceIdentity,
  document: ReturnType<typeof localPath>,
): DocumentReviewModel {
  const snapshot = sourceSnapshot(content)
  return {
    workspace,
    comments: [
      {
        id: 'comment',
        workspace,
        document,
        body: 'Review this',
        lifecycle: 'draft',
        anchor: {
          snapshot,
          range: { startLine: 2, endLine: 2 },
          excerpt: 'target',
          contextBefore: 'before\n',
          contextAfter: '\nafter',
          state: { status: 'current' },
        },
      },
    ],
    batches: [],
  }
}

function add(commentId: string, body: string): DocumentReviewAction {
  return {
    type: 'add-comment',
    workspace: workspaceA,
    commentId,
    body,
    capture: {
      document: documentA,
      snapshot: sourceSnapshot(content),
      content,
      range: { startLine: 2, endLine: 2 },
    },
  }
}

function sourceSnapshot(value: string) {
  return {
    algorithm: 'sha256' as const,
    digest: createHash('sha256').update(value).digest('hex'),
    byteLength: Buffer.byteLength(value),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}
