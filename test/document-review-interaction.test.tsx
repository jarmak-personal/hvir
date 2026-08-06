// @vitest-environment happy-dom

import { webcrypto } from 'node:crypto'

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentReviewWorkspaceBinding } from '../src/renderer/src/document-review/use-document-review-interaction'
import { FileViewer } from '../src/renderer/src/viewer/FileViewer'
import { renderMarkdown } from '../src/renderer/src/viewer/markdown-client'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import {
  localPath,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

vi.mock('../src/renderer/src/viewer/markdown-client', () => ({
  renderMarkdown: vi.fn(),
  resetMarkdownRenderer: vi.fn(),
}))

const workspace: ReviewWorkspaceIdentity = { id: 'workspace', root: localPath('/repo') }
const documentPath = localPath('/repo/review.md')
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges)
      }
    },
  )
  vi.stubGlobal('CSS', { highlights: { set: vi.fn(), delete: vi.fn() } })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Markdown document review interaction', () => {
  it('keeps ambient source selection and copying inert until explicit comment submission', async () => {
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    renderViewer(sourceTab(), binding(emptyModel(), apply))
    click('Enter Markdown review mode')

    act(() => {
      editorView().dispatch({ selection: { anchor: 0, head: 8 } })
      host
        .querySelector('.cm-content')
        ?.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }))
    })
    expect(apply).not.toHaveBeenCalled()

    click('Add comment for selected source lines')
    expect(apply).not.toHaveBeenCalled()
    setTextArea('New review comment', 'Explain this heading')
    await act(async () => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
        ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await settle()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      type: 'add-comment',
      workspace,
      body: 'Explain this heading',
      capture: {
        document: documentPath,
        range: { startLine: 1, endLine: 1 },
        snapshot: { algorithm: 'sha256' },
      },
    })
  })

  it('revokes a late snapshot digest when the viewer interaction unmounts', async () => {
    const digest = deferred<ArrayBuffer>()
    vi.stubGlobal('crypto', {
      subtle: { digest: vi.fn(() => digest.promise) },
      randomUUID: vi.fn(() => 'late-comment'),
    })
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    renderViewer(sourceTab(), binding(emptyModel(), apply))
    click('Enter Markdown review mode')
    act(() => editorView().dispatch({ selection: { anchor: 0, head: 8 } }))
    click('Add comment for selected source lines')
    setTextArea('New review comment', 'Late feedback')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
        ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      root.render(<div />)
    })

    await act(async () => {
      digest.resolve(new Uint8Array(32).buffer)
      await settle()
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps dirty-buffer capture and re-anchoring disabled with save-or-reload guidance', () => {
    const model = { ...emptyModel(), comments: [comment('draft', 'draft', 'current')] }
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model,
    }))
    renderViewer(sourceTab({ dirty: true }), binding(model, apply))
    click('Enter Markdown review mode')

    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Save or reload before adding or re-anchoring comments',
    )
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Add comment for selected source lines"]',
      )?.disabled,
    ).toBe(true)
    expect(button('Re-anchor')?.disabled).toBe(true)
    act(() => editorView().dispatch({ selection: { anchor: 0, head: 8 } }))
    expect(apply).not.toHaveBeenCalled()
  })

  it('presents lifecycle, moved, and stale states with text and distinct semantics', () => {
    const model = {
      ...emptyModel(),
      comments: [
        comment('draft', 'draft', 'current'),
        comment('sent', 'sent', 'moved'),
        comment('resolved', 'resolved', 'current'),
        comment('stale', 'draft', 'stale'),
      ],
    }
    renderViewer(sourceTab(), binding(model, vi.fn()))
    click('Enter Markdown review mode')

    expect(host.textContent).toContain('draft')
    expect(host.textContent).toContain('sent')
    expect(host.textContent).toContain('resolved')
    expect(host.textContent).toContain('Moved from Line 1')
    expect(host.textContent).toContain('Stale · missing match')
    expect(button('Add to batch', 1)?.disabled).toBe(true)
    expect(button('Acknowledge stale location')).toBeTruthy()
  })

  it('keeps normal Markdown reading quiet while retaining inline note markers', () => {
    const model = {
      ...emptyModel(),
      comments: [comment('quiet-note', 'draft', 'current')],
    }
    renderViewer(sourceTab(), binding(model, vi.fn()))

    expect(host.querySelector('.cm-review-marker')).toBeTruthy()
    expect(host.querySelector('[aria-label="Markdown review comments"]')).toBeNull()
    expect(button('Enter Markdown review mode')).toBeTruthy()
  })

  it('keeps one comment identity across source and rendered projections', async () => {
    const model = { ...emptyModel(), comments: [comment('same-note', 'draft', 'moved')] }
    vi.mocked(renderMarkdown).mockResolvedValue(
      '<h1 data-source-line="1" data-source-end-line="1">Heading</h1>',
    )
    const reviewBinding = binding(model, vi.fn())
    renderViewer(sourceTab(), reviewBinding)
    click('Enter Markdown review mode')
    expect(host.querySelector('.cm-review-marker')).toBeTruthy()
    expect(host.textContent).toContain('same-note')

    renderViewer(renderedTab(), reviewBinding)
    await act(async () => settle())

    expect(button('Exit Markdown review mode')).toBeTruthy()
    expect(host.querySelector('.review-block-badge')).toBeTruthy()
    expect(host.textContent).toContain('same-note')
  })

  it('supports rendered block keyboard navigation, capture, and exit with labeled controls', async () => {
    vi.mocked(renderMarkdown).mockResolvedValue(
      [
        '<h1 data-source-line="1" data-source-end-line="1">Heading</h1>',
        '<p data-source-line="3" data-source-end-line="3">Paragraph</p>',
      ].join(''),
    )
    renderViewer(renderedTab(), binding(emptyModel(), vi.fn()))
    await act(async () => settle())
    click('Enter Markdown review mode')
    await act(async () => settle())
    const blocks = [...host.querySelectorAll<HTMLElement>('.review-block-active')]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.getAttribute('aria-label')).toContain('Press Enter')
    expect(host.querySelector('[aria-label="Add comment for line 1"]')).toBeTruthy()

    act(() => {
      blocks[0]?.focus()
      blocks[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(blocks[1])
    act(() => {
      blocks[1]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    expect(host.querySelector('[aria-label="New comment for Line 3"]')).toBeTruthy()
    act(() => {
      blocks[1]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(button('Enter Markdown review mode')).toBeTruthy()
  })

  it('keeps entry, editing, removal, resolution, navigation, and exit natively reachable', () => {
    const model = {
      ...emptyModel(),
      comments: [
        comment('editable', 'draft', 'current'),
        comment('sent-note', 'sent', 'current'),
      ],
    }
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model,
    }))
    const onMode = vi.fn()
    renderViewer(sourceTab(), binding(model, apply), onMode)
    const entry = button('Enter Markdown review mode')
    expect(entry?.getAttribute('type')).toBe('button')
    expect(entry?.getAttribute('title')).toBe('Markdown review mode')
    click('Enter Markdown review mode')
    expect(button('Exit Markdown review mode')).toBeTruthy()
    expect(host.querySelector('[aria-label="Markdown review comments"]')).toBeTruthy()
    expect(host.querySelector('.cm-content')?.getAttribute('aria-label')).toBe(
      'Markdown source review',
    )

    click('Edit')
    setTextArea('Edit comment at Line 1', 'edited text')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="Edit comment at Line 1"]')
        ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    click('Remove')
    click('Resolve')
    click('Go to review comment at Line 1')
    expect(apply.mock.calls.map(([action]) => action.type)).toEqual([
      'edit-comment',
      'remove-comment',
      'resolve-comment',
    ])
    expect(onMode).toHaveBeenCalledWith('source', expect.any(Object))

    click('Exit Markdown review mode')
    expect(button('Enter Markdown review mode')).toBeTruthy()
  })

  it('adds and removes a draft from the exact workspace review batch', () => {
    const draft = comment('batch-note', 'draft', 'current')
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    const withoutBatch = { ...emptyModel(), comments: [draft] }
    renderViewer(sourceTab(), binding(withoutBatch, apply))
    click('Enter Markdown review mode')
    click('Add to batch')
    expect(apply).toHaveBeenLastCalledWith({
      type: 'create-batch',
      workspace,
      batchId: 'active-review',
      commentIds: [draft.id],
    })

    const withBatch = {
      ...withoutBatch,
      batches: [{ id: 'active-review', workspace, commentIds: [draft.id] }],
    }
    renderViewer(sourceTab(), binding(withBatch, apply))
    click('Remove from batch')
    expect(apply).toHaveBeenLastCalledWith({
      type: 'remove-from-batch',
      workspace,
      batchId: 'active-review',
      commentId: draft.id,
    })
  })

  it('does not project Markdown review controls onto diff mode', () => {
    const model = {
      ...emptyModel(),
      comments: [comment('source-only', 'draft', 'current')],
    }
    const diffTab: ViewerTab = {
      ...sourceTab(),
      mode: 'diff',
      position: { mode: 'diff', line: 1, scrollTop: 0 },
      loading: true,
    }
    renderViewer(diffTab, binding(model, vi.fn()))

    expect(host.querySelector('[aria-label="Document review"]')).toBeNull()
    expect(host.querySelector('[aria-label="Markdown review comments"]')).toBeNull()
  })

  it('does not install Markdown review chrome in a non-Markdown source viewer', () => {
    const source = sourceTab({ path: localPath('/repo/example.ts') })
    renderViewer(source, binding(emptyModel(), vi.fn()))

    expect(host.querySelector('[aria-label="Document review"]')).toBeNull()
    expect(host.querySelector('.cm-review-gutter')).toBeNull()
    expect(host.querySelector('.cm-content')?.getAttribute('aria-label')).not.toBe(
      'Source viewer',
    )
  })
})

function renderViewer(
  tab: ViewerTab,
  documentReview: DocumentReviewWorkspaceBinding,
  onMode = vi.fn(),
): void {
  act(() =>
    root.render(
      <FileViewer
        tab={tab}
        gitRefreshVersion={0}
        onMode={onMode}
        onDiffBase={vi.fn()}
        onContent={vi.fn()}
        onSave={vi.fn()}
        onReload={vi.fn()}
        onPosition={vi.fn()}
        onNavigationHandled={vi.fn()}
        registerCommands={() => () => undefined}
        onOpenPath={vi.fn()}
        onRenderedDependencies={vi.fn()}
        documentReview={documentReview}
      />,
    ),
  )
}

function sourceTab(
  overrides: { readonly dirty?: boolean; readonly path?: ViewerTab['path'] } = {},
): ViewerTab {
  return tab('source', overrides.dirty ?? false, overrides.path)
}

function renderedTab(dirty = false): ViewerTab {
  return tab('rendered', dirty)
}

function tab(
  mode: 'source' | 'rendered',
  dirty: boolean,
  path = documentPath,
): ViewerTab {
  const content = '# Heading\n\nParagraph\n'
  return {
    id: 'review-tab',
    path,
    pane: 'primary',
    pinned: true,
    mode,
    diffBase: 'head',
    position: { mode, line: 1, scrollTop: 0 },
    file: {
      path,
      content,
      size: 1024 * 1024 + 1,
      mtimeMs: 1,
      binary: false,
    },
    loading: false,
    dirty,
    conflict: false,
  }
}

function binding(
  model: DocumentReviewModel,
  apply: DocumentReviewWorkspaceBinding['apply'],
): DocumentReviewWorkspaceBinding {
  return {
    state: {
      status: 'ready',
      localGeneration: 1,
      workspace,
      workspaceGeneration: 1,
      revision: 1,
      model,
    },
    apply,
  }
}

function emptyModel(): DocumentReviewModel {
  return { workspace, comments: [], batches: [] }
}

function comment(
  body: string,
  lifecycle: DocumentReviewComment['lifecycle'],
  anchorState: 'current' | 'moved' | 'stale',
): DocumentReviewComment {
  const snapshot = {
    algorithm: 'sha256' as const,
    digest: 'a'.repeat(64),
    byteLength: 21,
  }
  return {
    id: `${body}-${lifecycle}-${anchorState}`,
    workspace,
    document: documentPath,
    body,
    lifecycle,
    anchor: {
      snapshot,
      range: { startLine: 1, endLine: 1 },
      excerpt: '# Heading',
      contextBefore: '',
      contextAfter: '\n\nParagraph',
      state:
        anchorState === 'moved'
          ? {
              status: 'moved',
              previous: { snapshot, range: { startLine: 1, endLine: 1 } },
            }
          : anchorState === 'stale'
            ? { status: 'stale', reason: 'missing-match', reviewed: false }
            : { status: 'current' },
    },
  }
}

function editorView(): EditorView {
  const editor = host.querySelector<HTMLElement>('.cm-editor')
  const view = editor && EditorView.findFromDOM(editor)
  if (!view) throw new Error('Expected CodeMirror editor')
  return view
}

function click(label: string): void {
  act(() => button(label)?.click())
}

function button(label: string, index = 0): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute('aria-label') === label,
  )[index]
}

function setTextArea(label: string, value: string): void {
  const textarea = host.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      value,
    )
    textarea?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
