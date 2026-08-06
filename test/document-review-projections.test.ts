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
      { active: true, comments: [], onCapture, onExit: vi.fn() },
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
    bindRenderedDocumentReview(
      root,
      {
        active: false,
        comments: [comment(1, 'stale')],
        onCapture: vi.fn(),
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
      '1 review note; stale',
    )
  })
})

describe('source Markdown review projection', () => {
  it('reconfigures one bounded projection without turning selection or copy into actions', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const onRange = vi.fn()
    const onExit = vi.fn()
    const compartment = new Compartment()
    const projection = {
      active: true,
      dirty: false,
      comments: Array.from({ length: 64 }, (_, index) => comment(index + 1)),
      onRange,
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
