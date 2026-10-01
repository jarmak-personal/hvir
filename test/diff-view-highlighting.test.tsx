// @vitest-environment happy-dom

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DiffView } from '../src/renderer/src/viewer/DiffView'
import { getHighlightWorker } from '../src/renderer/src/viewer/highlight-worker'
import { tokenDecorations } from '../src/renderer/src/viewer/source-highlighting'
import { SOURCE_HIGHLIGHT_BYTE_LIMIT } from '../src/renderer/src/viewer/viewer-workload-policy'
import { setAppTheme } from '../src/renderer/src/theme'
import type { ViewerPositionCapture } from '../src/renderer/src/viewer/viewer-position'
import type { RegisterViewerFindTarget } from '../src/renderer/src/viewer/viewer-find'
import {
  asHostId,
  hostPath,
  localPath,
  type DiffBase,
  type GitDiffResponse,
  type HostPath,
} from '../src/shared'
import { ViewerHighlightWorker } from './fixtures/viewer-highlight-worker'

vi.mock('../src/renderer/src/viewer/highlight-worker', () => ({
  getHighlightWorker: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
let worker: ViewerHighlightWorker
let response: GitDiffResponse
let invoke: Mock<() => Promise<GitDiffResponse>>
const positionCapture: ViewerPositionCapture = { current: undefined }
const registerFindTarget = () => () => undefined
const path = localPath('/repo/example.ts')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setAppTheme('dark')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  worker = new ViewerHighlightWorker()
  vi.mocked(getHighlightWorker).mockImplementation(() => worker as unknown as Worker)
  response = inputs('const oldValue = 1\n', 'const newValue = 2\n')
  invoke = vi.fn(() => Promise.resolve(response))
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  positionCapture.current = undefined
  setAppTheme('dark')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('diff highlighting through the shared worker port', () => {
  it.each([path, hostPath(asHostId('ssh-test'), path.path)])(
    'highlights each side from its own content for %o',
    async (qualifiedPath) => {
      await render({ path: qualifiedPath })
      expect(worker.requests.map(({ code }) => code)).toEqual([
        response.baseInput.content,
        response.currentInput.content,
      ])
      expect(worker.requests[0]!.id).not.toBe(worker.requests[1]!.id)
      await color(1, '#abcdef')
      expect(colors('base')).toEqual([])
      expect(colors('current')).toEqual(['color:#abcdef'])
      await color(0, '#123456')
      expect(colors('base')).toEqual(['color:#123456'])
      expect(documentText('base')).toBe(response.baseInput.content)
      expect(documentText('current')).toBe(response.currentInput.content)
    },
  )

  it.each(['base', 'current'] as const)(
    'preserves complete text and a Unicode/whitespace selection on the %s side through presentation changes',
    async (side) => {
      const line = `  \tconst description = 'café e\u0301 漢字 🚀 ${'long text '.repeat(40)}';  \t`
      const context = Array.from(
        { length: 24 },
        (_, index) => `// context ${index}`,
      ).join('\n')
      response = inputs(
        `const limit = 12\n${context}\n${line}\nconst old = true\n`,
        `const limit = 24\n${context}\n${line.replace('description', 'readable')}\nconst next = true\n`,
      )
      await render()
      const view = editor(side)
      const original = view.state.doc.toString()
      const selected = view.state.doc.line(26)
      // Include leading/trailing whitespace and a newline; reverse one side's range.
      const from = selected.from
      const to = selected.to + 1
      const anchor = side === 'base' ? from : to
      const head = side === 'base' ? to : from
      await update(() => view.dispatch({ selection: { anchor, head } }))
      const assertPreserved = () => {
        expect(editor(side)).toBe(view)
        expect(view.state.doc.toString()).toBe(original)
        expect(view.state.selection.main.anchor).toBe(anchor)
        expect(view.state.selection.main.head).toBe(head)
        expect(view.state.sliceDoc(from, to)).toBe(original.slice(from, to))
      }
      assertPreserved()
      await update(() => worker.respond({
        type: 'batch',
        id: worker.requests[side === 'base' ? 0 : 1]!.id,
        tokens: [{ from: selected.from, to: selected.to, color: '#abcdef' }],
      }))
      assertPreserved()
      const wrap = container.querySelector<HTMLButtonElement>('.diff-controls button')!
      await update(() => wrap.click())
      expect(wrap.getAttribute('aria-pressed')).toBe('false')
      expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
      assertPreserved()
      await update(() => wrap.click())
      expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
      assertPreserved()
      await update(() => setAppTheme('light'))
      assertPreserved()
      await color(2, '#456789')
      await color(3, '#789abc')
      assertPreserved()
      await update(() => setAppTheme('dark'))
      assertPreserved()
      const collapsed = container.querySelector<HTMLElement>('.cm-collapsedLines')
      expect(collapsed).not.toBeNull()
      await update(() =>
        collapsed!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
          }),
        ),
      )
      expect(collapsed!.isConnected).toBe(false)
      assertPreserved()
    },
  )

  it('refreshes only changed-side highlighting and rejects callbacks queued before replacement', async () => {
    await render()
    await color(0, '#123456')
    await color(1, '#abcdef')
    const merge = container.querySelector('.cm-mergeView')
    const queued = [...worker.messages] as EventListener[]
    const staleId = worker.requests[1]!.id
    response = inputs(response.baseInput.content, 'const refreshed = 3\n')
    await render({ gitRefreshVersion: 1 })
    expect(container.querySelector('.cm-mergeView')).toBe(merge)
    expect(worker.requests).toHaveLength(3)
    expect(colors('base')).toEqual(['color:#123456'])
    expect(colors('current')).toEqual([])
    await update(() => {
      const event = new MessageEvent('message', {
        data: {
          type: 'batch',
          id: staleId,
          tokens: [{ from: 0, to: 5, color: '#fedcba' }],
        },
      })
      for (const listener of queued) listener(event)
    })
    expect(colors('current')).toEqual([])
    await color(2, '#456789')
    expect(colors('current')).toEqual(['color:#456789'])
    expect(worker.messages.size).toBe(2)
    expect(worker.errors.size).toBe(2)
  })

  it('does not restart highlights for equivalent path objects or metadata refreshes', async () => {
    await render()
    await color(1, '#abcdef')
    await render({ path: localPath(path.path), gitRefreshVersion: 1 })
    expect(worker.requests).toHaveLength(2)
    expect(colors('current')).toEqual(['color:#abcdef'])
  })

  it('replaces both theme generations without replacing the merge view or accepting old tokens', async () => {
    await render()
    await color(0, '#123456')
    await color(1, '#abcdef')
    const merge = container.querySelector('.cm-mergeView')
    const queued = [...worker.messages] as EventListener[]
    const old = worker.requests.slice()
    await update(() => setAppTheme('light'))
    expect(container.querySelector('.cm-mergeView')).toBe(merge)
    expect(worker.requests.slice(2).map(({ theme }) => theme)).toEqual(['light', 'light'])
    expect(colors('base')).toEqual([])
    expect(colors('current')).toEqual([])
    await update(() => {
      for (const request of old) {
        const event = new MessageEvent('message', {
          data: {
            type: 'batch',
            id: request.id,
            tokens: [{ from: 0, to: 5, color: '#fedcba' }],
          },
        })
        for (const listener of queued) listener(event)
      }
    })
    expect(colors('base')).toEqual([])
    expect(colors('current')).toEqual([])
    await color(2, '#456789')
    await color(3, '#789abc')
    expect(colors('base')).toEqual(['color:#456789'])
    expect(colors('current')).toEqual(['color:#789abc'])
  })

  it('reuses stylesheet modules across wrapping changes and theme round trips', async () => {
    await render()
    const view = editor('current')
    const darkModules = view.state.facet(EditorView.styleModule)
    const toggleWrap = container.querySelector<HTMLButtonElement>('.diff-controls button')!
    await update(() => toggleWrap.click())
    expect(editor('current')).toBe(view)
    expect(view.state.facet(EditorView.styleModule)).toEqual(darkModules)
    expect(worker.requests).toHaveLength(2)
    await update(() => setAppTheme('light'))
    const lightModules = view.state.facet(EditorView.styleModule)
    expect(lightModules).not.toEqual(darkModules)
    await update(() => toggleWrap.click())
    expect(view.state.facet(EditorView.styleModule)).toEqual(lightModules)
    expect(worker.requests).toHaveLength(4)
    await update(() => setAppTheme('dark'))
    expect(view.state.facet(EditorView.styleModule)).toEqual(darkModules)
    await update(() => setAppTheme('light'))
    expect(view.state.facet(EditorView.styleModule)).toEqual(lightModules)
    expect(editor('current')).toBe(view)
  })

  it.each([
    { positionCapture: { current: undefined } },
    { registerFindTarget: () => () => undefined },
  ])('reattaches highlighting to replacement editors when bindings change: %o', async (next) => {
    await render()
    await color(0, '#123456')
    await color(1, '#abcdef')
    const former = editor('current')
    const queued = [...worker.messages] as EventListener[]
    const old = worker.requests.slice()
    // Changing content in the replacement commit must not restart the destroyed editor.
    response = inputs(response.baseInput.content, 'const replaced = 4\n')
    await render({ ...next, dirty: true })
    expect(editor('current')).not.toBe(former)
    expect(worker.requests).toHaveLength(4)
    expect(worker.requests.slice(2).map(({ code }) => code)).toEqual([
      response.baseInput.content,
      response.currentInput.content,
    ])
    expect(worker.messages.size).toBe(2)
    expect(worker.errors.size).toBe(2)
    expect(documentText('current')).toBe(response.currentInput.content)
    await update(() => {
      for (const request of old) {
        const event = new MessageEvent('message', {
          data: {
            type: 'batch',
            id: request.id,
            tokens: [{ from: 0, to: 5, color: '#fedcba' }],
          },
        })
        for (const listener of queued) listener(event)
      }
    })
    expect(colors('base')).toEqual([])
    expect(colors('current')).toEqual([])
    await color(2, '#456789')
    await color(3, '#789abc')
    expect(colors('base')).toEqual(['color:#456789'])
    expect(colors('current')).toEqual(['color:#789abc'])
  })

  it.each([
    { base: 'branch-point' as const },
    { revision: 'commit-b' },
    { path: hostPath(asHostId('ssh-next'), path.path) },
  ])('releases the former comparison before awaiting %o', async (next) => {
    await render()
    const queued = [...worker.messages] as EventListener[]
    const request = worker.requests[0]!
    let resolve!: (value: GitDiffResponse) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise<GitDiffResponse>((done) => {
          resolve = done
        }),
    )
    await render(next)
    expect(container.querySelector('.cm-mergeView')).toBeNull()
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
    await update(() => {
      for (const listener of queued)
        listener(
          new MessageEvent('message', {
            data: {
              type: 'batch',
              id: request.id,
              tokens: [{ from: 0, to: 5, color: '#fedcba' }],
            },
          }),
        )
      resolve(inputs('const nextBase = 1\n', 'const nextCurrent = 2\n'))
    })
    expect(worker.requests).toHaveLength(4)
    expect(colors('base')).toEqual([])
  })

  it('releases both requests on close and contains a callback queued before destruction', async () => {
    await render()
    const queued = [...worker.messages] as EventListener[]
    const request = worker.requests[0]!
    await update(() => root.render(null))
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
    expect(positionCapture.current).toBeUndefined()
    expect(() =>
      queued.forEach((listener) =>
        listener(
          new MessageEvent('message', {
            data: {
              type: 'batch',
              id: request.id,
              tokens: [{ from: 0, to: 5, color: '#fedcba' }],
            },
          }),
        ),
      ),
    ).not.toThrow()
  })

  it.each(['plain', 'error', 'worker-error'] as const)(
    'retains exact text and clears partial token output after %s',
    async (failure) => {
      await render()
      await color(1, '#abcdef')
      const id = worker.requests[1]!.id
      await update(() => {
        if (failure === 'worker-error') {
          worker.dispatchEvent(
            Object.assign(new Event('error'), { message: 'unavailable' }),
          )
        } else if (failure === 'error') {
          worker.respond({ type: 'error', id, message: 'grammar unavailable' })
        } else {
          worker.respond({ type: 'plain', id })
        }
      })
      expect(colors('current')).toEqual([])
      expect(documentText('current')).toBe(response.currentInput.content)
      expect(container.querySelector('.cm-mergeView')).not.toBeNull()
    },
  )

  it('keeps unsupported text plain without acquiring a worker', async () => {
    await render({ path: localPath('/repo/example.qzx') })
    expect(worker.requests).toHaveLength(0)
    expect(documentText('current')).toBe(response.currentInput.content)
  })

  it('enforces each side’s highlight byte budget without disabling the bounded diff', async () => {
    response = {
      ...response,
      baseInput: { ...response.baseInput, byteLength: SOURCE_HIGHLIGHT_BYTE_LIMIT + 1 },
    }
    await render()
    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0]!.code).toBe(response.currentInput.content)
    expect(documentText('base')).toBe(response.baseInput.content)
  })

  it('releases highlights when incomplete refreshed input requires a bounded fallback', async () => {
    await render()
    response = {
      ...response,
      currentInput: { ...response.currentInput, complete: false },
    }
    await render({ gitRefreshVersion: 1 })
    expect(container.querySelector('.cm-mergeView')).toBeNull()
    expect(container.textContent).toContain('Diff preview limited')
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
  })

  it('contains partial startup failure without breaking either document', async () => {
    worker.failPost = true
    await render()
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
    expect(documentText('base')).toBe(response.baseInput.content)
    expect(documentText('current')).toBe(response.currentInput.content)
  })
})

async function render(
  options: {
    path?: HostPath
    base?: DiffBase
    revision?: string
    gitRefreshVersion?: number
    dirty?: boolean
    positionCapture?: ViewerPositionCapture
    registerFindTarget?: RegisterViewerFindTarget
  } = {},
) {
  await update(() => {
    root.render(
      <DiffView
        path={options.path ?? path}
        base={options.base ?? 'working-tree'}
        revision={options.revision}
        gitRefreshVersion={options.gitRefreshVersion ?? 0}
        currentContent={response.currentInput.content}
        currentSize={response.currentInput.byteLength}
        documentRefreshVersion={0}
        dirty={options.dirty ?? false}
        position={{ mode: 'diff', line: 1, scrollTop: 0 }}
        onPosition={() => undefined}
        positionCapture={options.positionCapture ?? positionCapture}
        registerFindTarget={options.registerFindTarget ?? registerFindTarget}
      />,
    )
  })
}

function editor(side: 'base' | 'current'): EditorView {
  const dom = container.querySelector<HTMLElement>(
    `.cm-merge-${side === 'base' ? 'a' : 'b'}`,
  )
  const view = dom && EditorView.findFromDOM(dom)
  if (!view) throw new Error('Expected diff editor')
  return view
}
function colors(side: 'base' | 'current'): string[] {
  const decorations = editor(side).state.field(tokenDecorations)
  const result: string[] = []
  for (let cursor = decorations.iter(); cursor.value; cursor.next())
    result.push((cursor.value.spec as { attributes: { style: string } }).attributes.style)
  return result
}
function documentText(side: 'base' | 'current'): string {
  return editor(side).state.doc.toString()
}
async function color(requestIndex: number, color: string) {
  await update(() =>
    worker.respond({
      type: 'batch',
      id: worker.requests[requestIndex]!.id,
      tokens: [{ from: 0, to: 5, color }],
    }),
  )
}
function inputs(base: string, current: string): GitDiffResponse {
  const input = (content: string) => ({
    content,
    byteLength: new TextEncoder().encode(content).length,
    lineCount: content.split('\n').length,
    complete: true,
  })
  return {
    path,
    base: 'working-tree',
    baseLabel: 'Index',
    currentLabel: 'Working tree',
    baseInput: input(base),
    currentInput: input(current),
  }
}

async function update(action: () => void): Promise<void> {
  await act(async () => {
    action()
    await Promise.resolve()
  })
}
