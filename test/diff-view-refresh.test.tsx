// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiffView } from '../src/renderer/src/viewer/DiffView'
import { createFindWorker } from '../src/renderer/src/viewer/find-worker'
import type { ViewerFindTarget } from '../src/renderer/src/viewer/viewer-find'
import { ViewerFindWorker } from './fixtures/viewer-find-worker'

vi.mock('../src/renderer/src/viewer/find-worker', () => ({ createFindWorker: vi.fn() }))
import type { ViewerPositionCapture } from '../src/renderer/src/viewer/viewer-position'
import {
  asHostId,
  hostPath,
  localPath,
  type DiffBase,
  type GitDiffResponse,
  type HostPath,
} from '../src/shared'

let container: HTMLDivElement
let reactRoot: Root
let invoke: ReturnType<typeof vi.fn>
const positionCapture: ViewerPositionCapture = { current: undefined }
let findTarget: ViewerFindTarget | undefined
let workers: ViewerFindWorker[]
const registerFindTarget = (target: ViewerFindTarget): (() => void) => {
  findTarget = target
  return () => {
    if (findTarget === target) findTarget = undefined
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  workers = []
  vi.mocked(createFindWorker).mockImplementation(() => {
    const worker = new ViewerFindWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
  invoke = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  positionCapture.current = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DiffView refresh lifecycle', () => {
  it.each(['base', 'current'] as const)(
    'invalidates cached and in-flight find on a %s refresh',
    async (side) => {
      const path = localPath('/repo/design.md')
      const response = (fresh: boolean): GitDiffResponse => {
        const result = diffResponse(path, 'unused')
        const input = (document: 'base' | 'current') => {
          const content =
            (fresh && side === document ? 'fresh needle needle ' : 'needle ') +
            ' '.repeat(2200)
          return { content, byteLength: content.length, lineCount: 1, complete: true }
        }
        return { ...result, baseInput: input('base'), currentInput: input('current') }
      }
      invoke.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true))
      await renderDiff({ path, gitRefreshVersion: 0 })
      const target = findTarget!
      const query = { text: 'needle', caseSensitive: false }
      expect(target.update(query, 0).pending).toBe(true)
      await vi.waitFor(() =>
        expect(
          workers[0]!.postMessage.mock.calls.filter(([data]) => data.type === 'search'),
        ).toHaveLength(2),
      )
      for (const document of [0, 1]) {
        workers[0]!.respond({
          type: 'matches',
          document,
          ranges: new Uint32Array([0, 6]),
        })
        workers[0]!.respond({ type: 'done', document })
      }
      expect(target.update(query, 0).total).toBe(2)
      const nextQuery = { ...query, caseSensitive: true }
      expect(target.update(nextQuery, 0).pending).toBe(true)
      const pending = workers[1]!
      const changed = vi.fn()
      const unsubscribe = target.subscribe(changed)
      await renderDiff({ path, gitRefreshVersion: 1 })
      expect(findTarget).toBe(target)
      expect(changed).toHaveBeenCalled()
      expect(pending.terminate).toHaveBeenCalledOnce()
      const notifications = changed.mock.calls.length
      expect(target.update(nextQuery, 0).pending).toBe(true)
      const fresh = workers[2]!
      await vi.waitFor(() =>
        expect(fresh.postMessage).toHaveBeenCalledWith({
          type: 'chunk',
          content: response(true)[side === 'base' ? 'baseInput' : 'currentInput'].content,
        }),
      )
      pending.respond({ type: 'done', document: 0 })
      pending.respond({ type: 'done', document: 1 })
      expect(changed).toHaveBeenCalledTimes(notifications)
      expect(target.update(nextQuery, 0).pending).toBe(true)
      for (const document of [0, 1]) {
        const updated = (document === 0 ? 'base' : 'current') === side
        fresh.respond({
          type: 'matches',
          document,
          ranges: new Uint32Array(updated ? [6, 12, 13, 19] : [0, 6]),
        })
        fresh.respond({ type: 'done', document })
      }
      expect(target.update(nextQuery, 0)).toEqual({ current: 1, total: 3, side: 'base' })
      unsubscribe()
    },
  )

  it('applies a settled result before draining a coalesced refresh', async () => {
    const path = localPath('/repo/design.md')
    const active = deferred<GitDiffResponse>()
    const trailing = deferred<GitDiffResponse>()
    invoke
      .mockResolvedValueOnce(diffResponse(path, 'settled'))
      .mockReturnValueOnce(active.promise)
      .mockReturnValueOnce(trailing.promise)

    await renderDiff({ path, gitRefreshVersion: 0 })
    const settledMerge = mergeElement()
    expect(currentDocument()).toBe('settled\n')

    await renderDiff({ path, gitRefreshVersion: 1 })
    for (let gitRefreshVersion = 2; gitRefreshVersion <= 40; gitRefreshVersion += 1) {
      await renderDiff({ path, gitRefreshVersion })
    }
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mergeElement()).toBe(settledMerge)
    expect(container.textContent).not.toContain('Preparing diff')
    expect(currentDocument()).toBe('settled\n')

    await act(async () => {
      active.resolve(diffResponse(path, 'intermediate'))
      await settleEffects()
    })
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(mergeElement()).toBe(settledMerge)
    expect(currentDocument()).toBe('intermediate\n')

    await act(async () => {
      trailing.resolve(diffResponse(path, 'latest'))
      await settleEffects()
    })
    expect(mergeElement()).toBe(settledMerge)
    expect(currentDocument()).toBe('latest\n')
  })

  it('retains settled inputs and reports only the final burst failure', async () => {
    const path = localPath('/repo/design.md')
    const active = deferred<GitDiffResponse>()
    invoke
      .mockResolvedValueOnce(diffResponse(path, 'settled'))
      .mockReturnValueOnce(active.promise)
      .mockRejectedValueOnce(new Error('latest diff refresh failed'))

    await renderDiff({ path, gitRefreshVersion: 0 })
    const settledMerge = mergeElement()
    await renderDiff({ path, gitRefreshVersion: 1 })
    for (let gitRefreshVersion = 2; gitRefreshVersion <= 20; gitRefreshVersion += 1) {
      await renderDiff({ path, gitRefreshVersion })
    }

    await act(async () => {
      active.reject(new Error('superseded diff refresh failed'))
      await settleEffects()
    })

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(mergeElement()).toBe(settledMerge)
    expect(currentDocument()).toBe('settled\n')
    expect(container.querySelector('.diff-refresh-error')?.textContent).toContain(
      'latest diff refresh failed',
    )
    expect(container.textContent).not.toContain('superseded diff refresh failed')
  })

  it.each([
    [
      'host-qualified path',
      hostPath(asHostId('ssh-context'), '/repo/design.md'),
      'head' as const,
      undefined,
    ],
    ['diff base', localPath('/repo/design.md'), 'branch-point' as const, undefined],
    ['revision', localPath('/repo/design.md'), 'head' as const, 'remote-revision'],
  ])(
    'hides prior inputs and rejects late completion after a %s change',
    async (_context, nextPath, nextBase, nextRevision) => {
      const local = localPath('/repo/design.md')
      const oldContext = deferred<GitDiffResponse>()
      const newContext = deferred<GitDiffResponse>()
      invoke
        .mockResolvedValueOnce(diffResponse(local, 'settled'))
        .mockReturnValueOnce(oldContext.promise)
        .mockReturnValueOnce(newContext.promise)

      await renderDiff({ path: local, gitRefreshVersion: 0 })
      await renderDiff({ path: local, gitRefreshVersion: 1 })
      await renderDiff({
        path: nextPath,
        base: nextBase,
        revision: nextRevision,
        gitRefreshVersion: 1,
      })
      expect(container.textContent).toContain('Preparing diff')
      expect(container.querySelector('.cm-mergeView')).toBeNull()

      await act(async () => {
        oldContext.resolve(diffResponse(local, 'stale'))
        await settleEffects()
      })
      expect(invoke).toHaveBeenCalledTimes(3)
      expect(invoke).toHaveBeenLastCalledWith('git:diff-inputs', {
        path: nextPath,
        base: nextBase,
        revision: nextRevision,
      })
      expect(container.textContent).toContain('Preparing diff')

      await act(async () => {
        newContext.resolve(diffResponse(nextPath, 'latest context', nextBase))
        await settleEffects()
      })
      expect(currentDocument()).toBe('latest context\n')
      expect(container.textContent).not.toContain('stale')
    },
  )
})

async function renderDiff({
  path,
  base = 'head',
  revision,
  documentRefreshVersion = 0,
  gitRefreshVersion,
}: {
  readonly path: HostPath
  readonly base?: DiffBase
  readonly revision?: string
  readonly documentRefreshVersion?: number
  readonly gitRefreshVersion: number
}): Promise<void> {
  await act(async () => {
    reactRoot.render(
      <DiffView
        path={path}
        base={base}
        currentContent="working\n"
        currentSize={8}
        dirty={false}
        revision={revision}
        documentRefreshVersion={documentRefreshVersion}
        gitRefreshVersion={gitRefreshVersion}
        position={{ mode: 'diff', line: 1, scrollTop: 0 }}
        onPosition={() => undefined}
        positionCapture={positionCapture}
        registerFindTarget={registerFindTarget}
      />,
    )
    await settleEffects()
  })
}

function mergeElement(): HTMLElement {
  const merge = container.querySelector<HTMLElement>('.cm-mergeView')
  if (!merge) throw new Error('Expected interactive merge view')
  return merge
}

function currentDocument(): string {
  const editor = container.querySelector<HTMLElement>('.cm-editor.cm-merge-b')
  const view = editor ? EditorView.findFromDOM(editor) : undefined
  if (!view) throw new Error('Expected current-side CodeMirror view')
  return view.state.doc.toString()
}

function diffResponse(
  path: HostPath,
  current: string,
  base: DiffBase = 'head',
): GitDiffResponse {
  return {
    path,
    base,
    baseLabel: base === 'head' ? 'HEAD' : 'Branch point',
    currentLabel: 'Working tree',
    baseInput: {
      content: 'base\n',
      byteLength: 5,
      lineCount: 2,
      complete: true,
    },
    currentInput: {
      content: `${current}\n`,
      byteLength: current.length + 1,
      lineCount: 2,
      complete: true,
    },
  }
}

async function settleEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
