// @vitest-environment happy-dom

import { createHash } from 'node:crypto'

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  useReviewWorkspace,
  useWatchFanout,
} from '../src/renderer/src/document-review/use-document-review-workspace'
import {
  localPath,
  type DocumentReviewModel,
  type DocumentReviewWorkspaceSnapshot,
  type ReviewWorkspaceIdentity,
  type WatchEvent,
} from '../src/shared'

const workspaceA: ReviewWorkspaceIdentity = { id: 'a', root: localPath('/a') }
const workspaceB: ReviewWorkspaceIdentity = { id: 'b', root: localPath('/b') }
const documentA = localPath('/a/review.md')
let host: HTMLDivElement
let reactRoot: Root
let current: ReturnType<typeof useReviewWorkspace>
let invoke: Mock<
  (
    channel: string,
    request: { readonly workspace: ReviewWorkspaceIdentity },
  ) => Promise<unknown>
>
let watchHandler: (event: WatchEvent) => void

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

describe('useReviewWorkspace', () => {
  it('restores after React Strict Mode replays its lifecycle effects', async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: stored(workspaceA, emptyModel(workspaceA)),
    })

    act(() =>
      reactRoot.render(
        <StrictMode>
          <Harness workspace={workspaceA} />
        </StrictMode>,
      ),
    )
    await settle()

    expect(current.state).toMatchObject({ status: 'ready', workspace: workspaceA })
  })

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

  it('fans out through one stable callback into the composed review workspace', async () => {
    const viewerA = vi.fn()
    const viewerB = vi.fn()
    const model = modelWithComment()
    invoke.mockImplementation((channel) =>
      Promise.resolve({
        ok: true,
        value:
          channel === 'document-review:revalidate'
            ? {
                status: 'read',
                document: documentA,
                snapshot: model.comments[0]!.anchor.snapshot,
                content: 'before\ntarget\nafter\n',
              }
            : stored(workspaceA, model),
      }),
    )
    renderFanout(viewerA, workspaceA)
    await settle()
    const first = watchHandler
    const event: WatchEvent = { type: 'change', path: documentA }
    act(() => first(event))
    await settle()

    renderFanout(viewerB, workspaceA)
    expect(watchHandler).toBe(first)
    act(() => watchHandler(event))
    await settle()

    expect(viewerA).toHaveBeenCalledOnce()
    expect(viewerB).toHaveBeenCalledOnce()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'document-review:revalidate'),
    ).toHaveLength(2)
  })
})

function render(workspace?: ReviewWorkspaceIdentity): void {
  act(() => reactRoot.render(<Harness workspace={workspace} />))
}

function Harness({ workspace }: { readonly workspace?: ReviewWorkspaceIdentity }): null {
  const fanout = useWatchFanout(() => undefined)
  current = useReviewWorkspace(workspace, fanout)
  return null
}

function renderFanout(
  viewer: (event: WatchEvent) => void,
  workspace: ReviewWorkspaceIdentity,
): void {
  act(() => reactRoot.render(<FanoutHarness viewer={viewer} workspace={workspace} />))
}

function FanoutHarness({
  viewer,
  workspace,
}: {
  readonly viewer: (event: WatchEvent) => void
  readonly workspace: ReviewWorkspaceIdentity
}): null {
  const fanout = useWatchFanout(viewer)
  current = useReviewWorkspace(workspace, fanout)
  watchHandler = fanout.handle
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
