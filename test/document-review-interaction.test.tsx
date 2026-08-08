// @vitest-environment happy-dom

import { webcrypto } from 'node:crypto'

import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentReviewWorkspaceBinding } from '../src/renderer/src/document-review/use-document-review-interaction'
import { applyDocumentReviewAction } from '../src/renderer/src/document-review/document-review-model'
import { FileViewer } from '../src/renderer/src/viewer/FileViewer'
import { renderMarkdown } from '../src/renderer/src/viewer/markdown-client'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import {
  localPath,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type DocumentReviewRevalidation,
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
    const readDocument = vi.fn(authoritativeRead)
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    renderViewer(sourceTab(), binding(emptyModel(), apply, readDocument))
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
    expect(readDocument).toHaveBeenCalledExactlyOnceWith(documentPath)
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      type: 'add-comment',
      workspace,
      body: 'Explain this heading',
      batchId: 'active-review',
      capture: {
        document: documentPath,
        range: { startLine: 1, endLine: 1 },
        snapshot: { algorithm: 'sha256', digest: 'd'.repeat(64) },
        content: '# Heading\n\nParagraph\n',
      },
    })
  })

  it('starts a single-line source comment directly from the line-number gutter', () => {
    renderViewer(sourceTab(), binding(emptyModel(), vi.fn()))
    click('Enter Markdown review mode')

    const lineOne = [
      ...host.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'),
    ].find((element) => element.textContent === '1')
    expect(lineOne).toBeTruthy()
    act(() => {
      lineOne?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })

    expect(host.querySelector('[aria-label="New comment for Line 1"]')).toBeTruthy()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('New review comment')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('.document-review-inline')).toBeNull()
    expect(button('Exit Markdown review mode')).toBeTruthy()
  })

  it('preserves typed review text while the source projection remounts', () => {
    const review = binding(emptyModel(), vi.fn())
    renderViewer(sourceTab(), review)
    click('Enter Markdown review mode')
    click('Add comment for selected source lines')
    setTextArea('New review comment', 'Keep this unfinished thought')

    const addedElsewhere = comment('elsewhere', 'draft', 'current')
    renderViewer(
      sourceTab(),
      binding({ ...emptyModel(), comments: [addedElsewhere] }, vi.fn()),
    )

    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')?.value,
    ).toBe('Keep this unfinished thought')
  })

  it('revokes a late authoritative read when the viewer interaction unmounts', async () => {
    const read = deferred<DocumentReviewRevalidation>()
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    renderViewer(
      sourceTab(),
      binding(emptyModel(), apply, () => read.promise),
    )
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
      read.resolve(readResult(documentPath))
      await settle()
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects a disk snapshot that diverged from the visible buffer without writing', async () => {
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>()
    renderViewer(
      sourceTab(),
      binding(emptyModel(), apply, (document) =>
        Promise.resolve(readResult(document, '# Changed on disk\n')),
      ),
    )
    click('Enter Markdown review mode')
    act(() => editorView().dispatch({ selection: { anchor: 0, head: 8 } }))
    click('Add comment for selected source lines')
    setTextArea('New review comment', 'Must match what I reviewed')
    await submitNewComment()

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'on-disk Markdown changed before capture',
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an incomplete bounded read',
      () =>
        Promise.resolve({
          status: 'stale' as const,
          document: documentPath,
          reason: 'incomplete-read' as const,
        }),
      'exceeds the review read limit',
    ],
    [
      'a failed host read',
      () => Promise.reject(new Error('ProjectHost read failed')),
      'ProjectHost read failed',
    ],
  ])('refuses capture after %s without writing', async (_case, readDocument, message) => {
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>()
    renderViewer(sourceTab(), binding(emptyModel(), apply, readDocument))
    click('Enter Markdown review mode')
    act(() => editorView().dispatch({ selection: { anchor: 0, head: 8 } }))
    click('Add comment for selected source lines')
    setTextArea('New review comment', 'Feedback')
    await submitNewComment()

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message)
    expect(apply).not.toHaveBeenCalled()
  })

  it('revokes a late authoritative read when the visible path changes', async () => {
    const read = deferred<DocumentReviewRevalidation>()
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>()
    const review = binding(emptyModel(), apply, () => read.promise)
    renderViewer(sourceTab(), review)
    click('Enter Markdown review mode')
    act(() => editorView().dispatch({ selection: { anchor: 0, head: 8 } }))
    click('Add comment for selected source lines')
    setTextArea('New review comment', 'Late feedback')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
        ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    renderViewer(sourceTab({ path: localPath('/repo/other.md') }), review)
    await act(async () => {
      read.resolve(readResult(documentPath))
      await settle()
    })

    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps dirty-buffer capture disabled with visible save-or-reload guidance', () => {
    const model = { ...emptyModel(), comments: [comment('draft', 'draft', 'current')] }
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model,
    }))
    renderViewer(sourceTab({ dirty: true }), binding(model, apply))
    click('Enter Markdown review mode')
    clickSourceReviewMarker()

    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Add comment for selected source lines"]',
      )?.disabled,
    ).toBe(true)
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Save or reload to add comments',
    )
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
    clickSourceReviewMarker()

    expect(host.textContent).toContain('draft')
    expect(host.textContent).toContain('sent')
    expect(host.textContent).toContain('resolved')
    expect(host.textContent).toContain('Moved from Line 1')
    expect(host.textContent).toContain('Stale · missing match')
    expect(button('Acknowledge stale location for comment at Line 1')).toBeTruthy()
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

  it('keeps an out-of-range stale comment reachable after the document shrinks', () => {
    const base = comment('orphaned-note', 'draft', 'stale')
    const orphaned = {
      ...base,
      anchor: {
        ...base.anchor,
        range: { startLine: 99, endLine: 99 },
      },
    }
    renderViewer(sourceTab(), binding({ ...emptyModel(), comments: [orphaned] }, vi.fn()))
    click('Enter Markdown review mode')

    click('Open unplaced comment · Line 99')

    expect(host.textContent).toContain('orphaned-note')
    expect(host.querySelector('.document-review-inline-host-source')).toBeTruthy()
  })

  it('offers unplaced shortcuts only for drafts on the saved document snapshot', () => {
    const draft = comment('draft-orphan', 'draft', 'stale')
    const sent = comment('sent-orphan', 'sent', 'stale')
    const orphaned = (candidate: DocumentReviewComment) => ({
      ...candidate,
      anchor: {
        ...candidate.anchor,
        range: { startLine: 99, endLine: 99 },
      },
    })
    const reviewModel = {
      ...emptyModel(),
      comments: [orphaned(draft), orphaned(sent)],
    }

    renderViewer(sourceTab(), binding(reviewModel, vi.fn()))
    click('Enter Markdown review mode')
    expect(button('Open unplaced comment · Line 99')).toBeTruthy()
    expect(host.querySelectorAll('.document-review-orphan')).toHaveLength(1)

    renderViewer(sourceTab({ dirty: true }), binding(reviewModel, vi.fn()))
    expect(button('Open unplaced comment · Line 99')).toBeUndefined()
  })

  it('reopens review mode and the exact inline comment from its source marker', () => {
    const model = {
      ...emptyModel(),
      comments: [comment('source-marker-note', 'draft', 'current')],
    }
    renderViewer(sourceTab(), binding(model, vi.fn()))

    clickSourceReviewMarker()
    expect(button('Exit Markdown review mode')).toBeTruthy()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Review comment at Line 1',
    )

    click('Exit Markdown review mode')
    expect(host.querySelector('.document-review-inline')).toBeNull()
    clickSourceReviewMarker()
    expect(host.textContent).toContain('source-marker-note')
  })

  it('reopens review mode and focuses the exact comment from its rendered note badge', async () => {
    vi.mocked(renderMarkdown).mockResolvedValue(
      '<h1 data-source-line="1" data-source-end-line="1">Heading</h1>',
    )
    const model = {
      ...emptyModel(),
      comments: [comment('badge-note', 'draft', 'current')],
    }
    renderViewer(renderedTab(), binding(model, vi.fn()))
    await act(async () => settle())

    expect(button('Enter Markdown review mode')).toBeTruthy()
    click('Open 1 review note at line 1; current')

    expect(button('Exit Markdown review mode')).toBeTruthy()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Review comment at Line 1',
    )
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
    clickSourceReviewMarker()
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
    expect(document.activeElement?.getAttribute('aria-label')).toBe('New review comment')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('.document-review-inline')).toBeNull()
    expect(button('Exit Markdown review mode')).toBeTruthy()
    act(() => {
      blocks[1]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(button('Enter Markdown review mode')).toBeTruthy()
  })

  it('uses the same authoritative read for rendered capture as source capture', async () => {
    vi.mocked(renderMarkdown).mockResolvedValue(
      '<h1 data-source-line="1" data-source-end-line="1">Heading</h1>',
    )
    const readDocument = vi.fn(authoritativeRead)
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((_action) => ({
      ok: true,
      model: emptyModel(),
    }))
    renderViewer(renderedTab(), binding(emptyModel(), apply, readDocument))
    await act(async () => settle())
    click('Enter Markdown review mode')
    await act(async () => settle())
    click('Add comment for line 1')
    setTextArea('New review comment', 'Rendered feedback')
    await submitNewComment()

    expect(readDocument).toHaveBeenCalledExactlyOnceWith(documentPath)
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      type: 'add-comment',
      capture: {
        document: documentPath,
        content: '# Heading\n\nParagraph\n',
        snapshot: { digest: 'd'.repeat(64) },
      },
    })
  })

  it('keeps entry, click-to-edit, removal, navigation, and exit natively reachable', () => {
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
    clickSourceReviewMarker()

    click('Edit comment at Line 1')
    setTextArea('Edit comment at Line 1', 'edited text')
    act(() => {
      host
        .querySelector<HTMLTextAreaElement>('[aria-label="Edit comment at Line 1"]')
        ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    click('Remove comment at Line 1')
    click('Go to review comment at Line 1')
    expect(apply.mock.calls.map(([action]) => action.type)).toEqual([
      'edit-comment',
      'remove-comment',
    ])
    expect(onMode).toHaveBeenCalledWith('source', expect.any(Object))

    click('Exit Markdown review mode')
    expect(button('Enter Markdown review mode')).toBeTruthy()
  })

  it('clears workspace history deliberately while preserving every draft', () => {
    const model = {
      ...emptyModel(),
      comments: [
        comment('keep-draft', 'draft', 'current'),
        comment('old-sent', 'sent', 'current'),
        comment('old-resolved', 'resolved', 'current'),
      ],
    }
    let cleared: DocumentReviewModel = model
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((action) => {
      const result = applyDocumentReviewAction(cleared, action)
      if (result.ok) cleared = result.model
      return result
    })
    renderViewer(sourceTab(), binding(model, apply))
    click('Enter Markdown review mode')

    const clear = button('Clear 2 sent and resolved review comments from this workspace')
    expect(clear?.getAttribute('type')).toBe('button')
    act(() => clear?.click())
    expect(apply).toHaveBeenCalledWith({
      type: 'clear-history',
      workspace,
      history: 'all',
    })
    expect(cleared.comments.map((candidate) => candidate.body)).toEqual(['keep-draft'])

    renderViewer(sourceTab(), binding(cleared, apply))
    expect(
      button('Clear 1 sent and resolved review comment from this workspace'),
    ).toBeUndefined()
    clickSourceReviewMarker()
    expect(host.textContent).toContain('keep-draft')
    expect(host.textContent).not.toContain('old-sent')
    expect(host.textContent).not.toContain('old-resolved')
  })

  it('returns to the review empty state after clearing history-only records', () => {
    const model = {
      ...emptyModel(),
      comments: [comment('old-sent', 'sent', 'current')],
    }
    let cleared: DocumentReviewModel = model
    const apply = vi.fn<DocumentReviewWorkspaceBinding['apply']>((action) => {
      const result = applyDocumentReviewAction(cleared, action)
      if (result.ok) cleared = result.model
      return result
    })
    renderViewer(sourceTab(), binding(model, apply))
    click('Enter Markdown review mode')
    click('Clear 1 sent and resolved review comment from this workspace')
    renderViewer(sourceTab(), binding(cleared, apply))

    expect(host.querySelector('.document-review-inline')).toBeNull()
    expect(host.querySelector('.cm-review-marker')).toBeNull()
    expect(button('Exit Markdown review mode')?.textContent).toBe('Review')
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
  readDocument: DocumentReviewWorkspaceBinding['readDocument'] = authoritativeRead,
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
    readDocument,
    flush: () => Promise.resolve(),
    adoptAuthoritative: () => true,
  }
}

function authoritativeRead(
  document: typeof documentPath,
): Promise<DocumentReviewRevalidation> {
  return Promise.resolve(readResult(document))
}

function readResult(
  document: typeof documentPath,
  content = '# Heading\n\nParagraph\n',
): Extract<DocumentReviewRevalidation, { status: 'read' }> {
  return {
    status: 'read',
    document,
    snapshot: {
      algorithm: 'sha256',
      digest: 'd'.repeat(64),
      byteLength: new TextEncoder().encode(content).byteLength,
    },
    content,
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

function clickSourceReviewMarker(): void {
  const marker = host.querySelector<HTMLElement>('.cm-review-marker')
  if (!marker) throw new Error('Expected a source review marker')
  act(() => {
    marker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
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

async function submitNewComment(): Promise<void> {
  await act(async () => {
    host
      .querySelector<HTMLTextAreaElement>('[aria-label="New review comment"]')
      ?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
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
