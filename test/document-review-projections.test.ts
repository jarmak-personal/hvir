// @vitest-environment happy-dom

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bindRenderedDocumentReview,
  type RenderedReviewScheduler,
} from '../src/renderer/src/document-review/document-review-rendered'
import {
  createDocumentReviewSourceExtensions,
  sourceReviewSelection,
} from '../src/renderer/src/document-review/document-review-source'
import {
  localPath,
  type DocumentReviewComment,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const workspace: ReviewWorkspaceIdentity = { id: 'workspace', root: localPath('/repo') }
const documentPath = localPath('/repo/review.md')

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('rendered Markdown review projection', () => {
  it('does no review work before a frame and processes long documents in bounded chunks', () => {
    const root = renderedRoot(250)
    const scheduler = new TestScheduler()
    const onCapture = vi.fn()
    const dispose = bindRenderedDocumentReview(
      root,
      {
        active: true,
        dirty: false,
        comments: [],
        onInlineHost: inlineHostRegistration(),
        onCapture,
        onOpenComment: vi.fn(),
        onExit: vi.fn(),
      },
      scheduler,
    )

    expect(root.querySelectorAll('.review-block')).toHaveLength(0)
    scheduler.runNext()
    expect(root.querySelectorAll('.review-block')).toHaveLength(100)
    root.dispatchEvent(new Event('select', { bubbles: true }))
    root.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(onCapture).not.toHaveBeenCalled()
    scheduler.runNext()
    expect(root.querySelectorAll('.review-block')).toHaveLength(200)
    scheduler.runNext()
    expect(root.querySelectorAll('.review-block')).toHaveLength(250)

    root
      .querySelector<HTMLButtonElement>('[data-review-capture]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onCapture).toHaveBeenCalledOnce()
    expect(onCapture).toHaveBeenCalledWith({ startLine: 1, endLine: 1 })

    dispose()
    expect(root.querySelectorAll('.review-block')).toHaveLength(150)
    scheduler.runNext()
    expect(root.querySelectorAll('.review-block')).toHaveLength(50)
    scheduler.runNext()
    expect(root.querySelectorAll('.review-block')).toHaveLength(0)
  })

  it('shows existing stale notes without exposing capture affordances outside review mode', () => {
    const root = renderedRoot(2)
    const scheduler = new TestScheduler()
    const onOpenComment = vi.fn()
    bindRenderedDocumentReview(
      root,
      {
        active: false,
        dirty: false,
        comments: [comment(1, 'stale')],
        onInlineHost: inlineHostRegistration(),
        onCapture: vi.fn(),
        onOpenComment,
        onExit: vi.fn(),
      },
      scheduler,
    )
    scheduler.runNext()

    const noted = root.querySelector<HTMLElement>('.review-block-noted')
    expect(noted?.getAttribute('data-review-anchor-state')).toBe('stale')
    expect(noted?.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('[data-review-capture]')).toBeNull()
    expect(root.querySelector('.review-block-badge')?.textContent).toBe('! 1')
    expect(root.querySelector('.review-block-badge')?.getAttribute('aria-label')).toBe(
      'Open 1 review note at line 1; stale',
    )
    root
      .querySelector<HTMLButtonElement>('.review-block-badge')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onOpenComment).toHaveBeenCalledExactlyOnceWith(comment(1, 'stale'))
  })

  it('groups active capture and note controls in one rendered-document gutter', () => {
    const root = renderedRoot(1)
    const scheduler = new TestScheduler()
    bindRenderedDocumentReview(
      root,
      {
        active: true,
        dirty: false,
        comments: [comment(1)],
        onInlineHost: inlineHostRegistration(),
        onCapture: vi.fn(),
        onOpenComment: vi.fn(),
        onExit: vi.fn(),
      },
      scheduler,
    )
    scheduler.runNext()

    const controls = root.querySelector('.review-block-controls')
    expect(controls?.children).toHaveLength(2)
    expect(controls?.querySelector('.review-block-add')).toBeTruthy()
    expect(controls?.querySelector('.review-block-badge')).toBeTruthy()
  })

  it('mounts and releases one inline host immediately after the selected block', () => {
    const root = renderedRoot(3)
    const scheduler = new TestScheduler()
    const unregister = vi.fn()
    const onInlineHost = vi.fn(() => unregister)
    const dispose = bindRenderedDocumentReview(
      root,
      {
        active: true,
        dirty: false,
        comments: [comment(2)],
        inlineRange: { startLine: 2, endLine: 2 },
        onInlineHost,
        onCapture: vi.fn(),
        onOpenComment: vi.fn(),
        onExit: vi.fn(),
      },
      scheduler,
    )
    scheduler.runNext()

    const inlineHost = root.querySelector<HTMLElement>('[data-review-inline-host]')
    expect(inlineHost?.previousElementSibling?.textContent).toContain('Line 2')
    expect(onInlineHost).toHaveBeenCalledExactlyOnceWith(inlineHost)

    dispose()
    expect(unregister).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-review-inline-host]')).toBeNull()
  })

  it('keeps dirty review blocks navigable without advertising or accepting capture', () => {
    const root = renderedRoot(2)
    const scheduler = new TestScheduler()
    const onCapture = vi.fn()
    bindRenderedDocumentReview(
      root,
      {
        active: true,
        dirty: true,
        comments: [],
        onInlineHost: inlineHostRegistration(),
        onCapture,
        onOpenComment: vi.fn(),
        onExit: vi.fn(),
      },
      scheduler,
    )
    scheduler.runNext()

    const blocks = [...root.querySelectorAll<HTMLElement>('.review-block-active')]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.getAttribute('aria-label')).toContain(
      'Save or reload before adding a comment',
    )
    expect(root.querySelector('[data-review-capture]')).toBeNull()
    blocks[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    expect(onCapture).not.toHaveBeenCalled()
  })
})

describe('source Markdown review projection', () => {
  it('reconfigures one bounded projection without turning selection or copy into actions', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const onRange = vi.fn()
    const onCapture = vi.fn()
    const onOpenComment = vi.fn()
    const onExit = vi.fn()
    const compartment = new Compartment()
    const projection = {
      active: true,
      dirty: false,
      comments: Array.from({ length: 64 }, (_, index) => comment(index + 1)),
      onInlineHost: inlineHostRegistration(),
      onRange,
      onCapture,
      onOpenComment,
      onExit,
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: Array.from({ length: 64 }, (_, index) => `line ${index + 1}`).join('\n'),
        extensions: [compartment.of(createDocumentReviewSourceExtensions(projection))],
      }),
    })

    for (let index = 0; index < 3; index += 1) {
      view.dispatch({
        effects: compartment.reconfigure(
          createDocumentReviewSourceExtensions(projection),
        ),
      })
    }
    expect(parent.querySelectorAll('.cm-review-gutter')).toHaveLength(1)
    expect(onRange).not.toHaveBeenCalled()
    view.dispatch({ selection: { anchor: 0, head: 13 } })
    view.contentDOM.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(onRange).toHaveBeenCalledOnce()
    expect(onRange).toHaveBeenCalledWith({ startLine: 1, endLine: 2 })
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Markdown source review')
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(onExit).toHaveBeenCalledOnce()
    view.destroy()
  })

  it('uses the source review gutter for direct capture and existing-note navigation', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const onCapture = vi.fn()
    const onOpenComment = vi.fn()
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [
          createDocumentReviewSourceExtensions({
            active: true,
            dirty: false,
            comments: [comment(1)],
            onInlineHost: inlineHostRegistration(),
            onRange: vi.fn(),
            onCapture,
            onOpenComment,
            onExit: vi.fn(),
          }),
        ],
      }),
    })

    parent
      .querySelector<HTMLElement>('.cm-review-marker')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    expect(onOpenComment).toHaveBeenCalledExactlyOnceWith(comment(1))

    const emptyGutterLine = [
      ...parent.querySelectorAll<HTMLElement>('.cm-review-gutter .cm-gutterElement'),
    ].find((element) => !element.querySelector('.cm-review-marker'))
    emptyGutterLine?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    )
    expect(onCapture).toHaveBeenCalledOnce()
    // happy-dom has no gutter geometry, so CodeMirror resolves the synthetic
    // click to the first line. Browser geometry is covered by the Electron smoke.
    expect(onCapture).toHaveBeenCalledWith({ startLine: 1, endLine: 1 })
    view.destroy()
  })

  it('mounts and releases a block widget below the selected source line', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const unregister = vi.fn()
    const onInlineHost = vi.fn(() => unregister)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [
          createDocumentReviewSourceExtensions({
            active: true,
            dirty: false,
            comments: [comment(2)],
            inlineRange: { startLine: 2, endLine: 2 },
            onInlineHost,
            onRange: vi.fn(),
            onCapture: vi.fn(),
            onOpenComment: vi.fn(),
            onExit: vi.fn(),
          }),
        ],
      }),
    })

    const inlineHost = parent.querySelector<HTMLElement>('[data-review-inline-host]')
    expect(inlineHost?.previousElementSibling?.textContent).toBe('two')
    expect(inlineHost?.nextElementSibling?.textContent).toBe('three')
    expect(onInlineHost).toHaveBeenCalledExactlyOnceWith(inlineHost)

    view.destroy()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('keeps a selection ending at the next line boundary on the prior source line', () => {
    const state = EditorState.create({ doc: 'one\ntwo\nthree' })
    const selected = state.update({ selection: { anchor: 0, head: 4 } }).state
    expect(sourceReviewSelection(selected)).toEqual({ startLine: 1, endLine: 1 })
  })
})

class TestScheduler implements RenderedReviewScheduler {
  private readonly pending: FrameRequestCallback[] = []

  request(callback: FrameRequestCallback): number {
    this.pending.push(callback)
    return this.pending.length
  }

  cancel(_handle: number): void {}

  runNext(): void {
    const callback = this.pending.shift()
    if (!callback) throw new Error('Expected a scheduled review frame')
    callback(0)
  }
}

function renderedRoot(count: number): HTMLElement {
  const root = document.createElement('div')
  for (let line = 1; line <= count; line += 1) {
    const block = document.createElement('p')
    block.dataset.sourceLine = String(line)
    block.dataset.sourceEndLine = String(line)
    block.textContent = `Line ${line}`
    root.append(block)
  }
  document.body.append(root)
  return root
}

function inlineHostRegistration(): (host: HTMLElement) => () => void {
  return vi.fn(() => vi.fn())
}

function comment(
  line: number,
  state: 'current' | 'stale' = 'current',
): DocumentReviewComment {
  return {
    id: `comment-${line}`,
    workspace,
    document: documentPath,
    body: `Review line ${line}`,
    lifecycle: 'draft',
    anchor: {
      snapshot: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        byteLength: 1,
      },
      range: { startLine: line, endLine: line },
      excerpt: `Line ${line}`,
      contextBefore: '',
      contextAfter: '',
      state:
        state === 'stale'
          ? { status: 'stale', reason: 'missing-match', reviewed: false }
          : { status: 'current' },
    },
  }
}
