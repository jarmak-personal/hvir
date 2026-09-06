// @vitest-environment happy-dom

import { EditorView, runScopeHandlers } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceView } from '../src/renderer/src/viewer/SourceView'
import { setAppTheme } from '../src/renderer/src/theme'
import { asHostId, hostPath, localPath } from '../src/shared'
import { ViewerHighlightWorker } from './fixtures/viewer-highlight-worker'

let worker: ViewerHighlightWorker
vi.mock('../src/renderer/src/viewer/highlight-worker', () => ({
  getHighlightWorker: () => worker,
}))

let host: HTMLDivElement
let root: Root
const onContent = vi.fn()
const onSave = vi.fn()
const unregister = vi.fn()
const registerFindTarget = vi.fn(() => unregister)
const capture: {
  current: (() => { mode: 'source'; line: number; scrollTop: number }) | undefined
} = { current: undefined }

beforeEach(() => {
  worker = new ViewerHighlightWorker()
  setAppTheme('dark')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function render(content: string, path = localPath('/repo/example.ts')): EditorView {
  act(() =>
    root.render(
      <SourceView
        path={path}
        content={content}
        size={new TextEncoder().encode(content).byteLength}
        position={{ mode: 'source', line: 1, scrollTop: 0 }}
        onContent={onContent}
        onSave={onSave}
        onPosition={() => undefined}
        blame={[]}
        blameStatus=""
        positionCapture={capture}
        onNavigationHandled={() => undefined}
        registerFindTarget={registerFindTarget}
      />,
    ),
  )
  const element = host.querySelector<HTMLElement>('.cm-editor')!
  return EditorView.findFromDOM(element)!
}

describe('source presentation content and resource lifetime', () => {
  it('reports edits and save, consumes the parent echo with its updated UTF-8 size, and keeps external reload silent', () => {
    const editor = render('const value = 1')
    expect(worker.requests).toHaveLength(1)
    const edited = 'const value = 1 // π'
    act(() =>
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' // π' } }),
    )
    expect(onContent).toHaveBeenCalledExactlyOnceWith(edited)
    expect(render(edited)).toBe(editor)
    expect(worker.requests).toHaveLength(1)
    expect(worker.messages.size).toBe(0)

    act(() => {
      runScopeHandlers(
        editor,
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true }),
        'editor',
      )
    })
    expect(onSave).toHaveBeenCalledOnce()

    render('const value = 2 // external')
    expect(editor.state.doc.toString()).toBe('const value = 2 // external')
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(worker.requests).toHaveLength(2)
    expect(worker.requests[1]?.code).toBe('const value = 2 // external')

    // A later disk snapshot equal to the earlier edit is no longer an edit echo.
    render(edited)
    expect(worker.requests).toHaveLength(3)
    expect(onContent).toHaveBeenCalledTimes(1)
  })

  it('highlights the current edited document for a new theme and rejects an obsolete theme response', () => {
    const editor = render('const value = 1')
    act(() => editor.dispatch({ changes: { from: 14, to: 15, insert: '2' } }))
    render('const value = 2')
    act(() => setAppTheme('light'))
    expect(worker.requests).toHaveLength(2)
    expect(worker.requests[1]).toMatchObject({ code: 'const value = 2', theme: 'light' })
    act(() =>
      worker.respond({ type: 'error', id: worker.requests[0]!.id, message: 'obsolete' }),
    )
    expect(host.textContent).not.toContain('obsolete')
    act(() =>
      worker.respond({ type: 'done', id: worker.requests[1]!.id, language: 'ts' }),
    )
    expect(host.querySelector('.source-meta')?.textContent).toContain('ts')
  })

  it.each([
    localPath('/repo/replacement.ts'),
    hostPath(asHostId('ssh-fixture'), '/repo/example.ts'),
  ])('replaces editor and find/worker resources for equal content at %j', (path) => {
    const editor = render('const value = 1')
    act(() => editor.dispatch({ changes: { from: 14, to: 15, insert: '2' } }))
    const replacement = render('const value = 2', path)
    expect(replacement).not.toBe(editor)
    expect(unregister).toHaveBeenCalledOnce()
    expect(registerFindTarget).toHaveBeenCalledTimes(2)
    expect(worker.requests).toHaveLength(2)
    expect(worker.messages.size).toBe(1)
    expect(worker.errors.size).toBe(1)
    act(() =>
      worker.respond({ type: 'error', id: worker.requests[0]!.id, message: 'obsolete' }),
    )
    expect(host.textContent).not.toContain('obsolete')
    act(() => root.render(null))
    expect(capture.current).toBeUndefined()
    expect(unregister).toHaveBeenCalledTimes(2)
    expect(worker.messages.size).toBe(0)
    expect(worker.errors.size).toBe(0)
    expect(onContent).toHaveBeenCalledTimes(1)
  })

  it('applies bounded token decorations with the existing styles and resets them on external replacement', () => {
    const editor = render('const value = 1')
    act(() =>
      worker.respond({
        type: 'batch',
        id: worker.requests[0]!.id,
        tokens: [
          { from: 0, to: 5, color: '#abcdef', backgroundColor: '#123456', fontStyle: 15 },
          { from: -1, to: 2, color: '#ff0000' },
          { from: 0, to: 99, color: '#ff0000' },
        ],
      }),
    )
    const decorated = host.querySelector<HTMLElement>('.cm-line span[style]')
    expect(decorated?.textContent).toBe('const')
    expect(decorated?.style.color).toBe('#abcdef')
    expect(decorated?.style.backgroundColor).toBe('#123456')
    expect(decorated?.style.fontStyle).toBe('italic')
    expect(decorated?.style.fontWeight).toBe('700')
    expect(decorated?.style.textDecoration).toBe('underline line-through')
    render('plain replacement')
    expect(editor.state.doc.toString()).toBe('plain replacement')
    expect(host.querySelector('.cm-line span[style]')).toBeNull()
  })
})
