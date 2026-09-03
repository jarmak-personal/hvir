// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiffView } from '../src/renderer/src/viewer/DiffView'
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
const registerFindTarget = (): (() => void) => () => undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
