// @vitest-environment happy-dom

import { createHash } from 'node:crypto'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useDocumentReviewWorkspace } from '../src/renderer/src/document-review/use-document-review-workspace'
import {
  localPath,
  type DocumentReviewModel,
  type DocumentReviewWorkspaceSnapshot,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const workspaceA: ReviewWorkspaceIdentity = { id: 'a', root: localPath('/a') }
const workspaceB: ReviewWorkspaceIdentity = { id: 'b', root: localPath('/b') }
const documentA = localPath('/a/review.md')
let host: HTMLDivElement
let reactRoot: Root
let current: ReturnType<typeof useDocumentReviewWorkspace>
let invoke: Mock<
  (
    channel: string,
    request: { readonly workspace: ReviewWorkspaceIdentity },
  ) => Promise<unknown>
>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  invoke = vi.fn()
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useDocumentReviewWorkspace', () => {
  it('clears the prior model and watch paths when the workspace becomes undefined', async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: stored(workspaceA, modelWithComment()),
    })
    render(workspaceA)
    await settle()
    expect(current.state.status).toBe('ready')
    expect(current.watchPaths).toEqual([documentA])

    render(undefined)
    expect(current.state.status).toBe('idle')
    expect(current.watchPaths).toEqual([])
  })

  it('does not publish a late restore from the previous workspace', async () => {
    const late = deferred<{ ok: true; value: DocumentReviewWorkspaceSnapshot }>()
    invoke.mockImplementation((_channel, request) =>
      request.workspace.id === 'a'
        ? late.promise
        : Promise.resolve({
            ok: true,
            value: stored(workspaceB, emptyModel(workspaceB)),
          }),
    )
    render(workspaceA)
    render(workspaceB)
    await settle()
    expect(current.state).toMatchObject({ status: 'ready', workspace: workspaceB })

    late.resolve({ ok: true, value: stored(workspaceA, modelWithComment()) })
    await settle()
    expect(current.state).toMatchObject({ status: 'ready', workspace: workspaceB })
    expect(current.watchPaths).toEqual([])
  })
})

function render(workspace?: ReviewWorkspaceIdentity): void {
  act(() => reactRoot.render(<Harness workspace={workspace} />))
}

function Harness({ workspace }: { readonly workspace?: ReviewWorkspaceIdentity }): null {
  current = useDocumentReviewWorkspace(workspace)
  return null
}

function stored(
  _workspace: ReviewWorkspaceIdentity,
  model: DocumentReviewModel,
): DocumentReviewWorkspaceSnapshot {
  return { workspaceGeneration: 1, revision: 1, model }
}

function emptyModel(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  return { workspace, comments: [], batches: [] }
}

function modelWithComment(): DocumentReviewModel {
  const content = 'before\ntarget\nafter\n'
  return {
    workspace: workspaceA,
    comments: [
      {
        id: 'comment',
        workspace: workspaceA,
        document: documentA,
        body: 'Review this',
        lifecycle: 'draft',
        anchor: {
          snapshot: {
            algorithm: 'sha256',
            digest: createHash('sha256').update(content).digest('hex'),
            byteLength: Buffer.byteLength(content),
          },
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
