import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { GitBlameRun, HostPath } from '../../../shared'
import { useAppTheme } from '../theme'
import { useDocumentReviewInlineHostRegistration } from '../document-review/document-review-inline'
import type { DocumentReviewDocumentProjection } from '../document-review/use-document-review-interaction'
import {
  createDocumentReviewSourceExtensions,
  sourceReviewSelection,
} from '../document-review/document-review-source'
import { CodeMirrorFindTarget, viewerFindDecorations } from './codemirror-find-target'
import { captureTopLine, restoreCodePosition } from './code-scroll-anchor'
import { resolveSourceCoordinate } from './source-coordinate'
import type { ViewerDocumentPosition, ViewerTab } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import type { ViewerPositionCapture } from './viewer-position'
import { blameGutter } from './source-blame-gutter'
import { highlightSource, resetTokens, tokenDecorations } from './source-highlighting'
import { formatViewerBytes } from './viewer-byte-format'

export function SourceView({
  path,
  content,
  size,
  position,
  onContent,
  onSave,
  onPosition,
  blame,
  blameStatus,
  positionCapture,
  navigation,
  onNavigationHandled,
  registerFindTarget,
  documentReview,
}: {
  readonly path: HostPath
  readonly content: string
  readonly size: number
  readonly position: ViewerDocumentPosition
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly blame: readonly GitBlameRun[]
  readonly blameStatus: string
  readonly positionCapture: ViewerPositionCapture
  readonly navigation?: ViewerTab['navigation']
  readonly onNavigationHandled: (serial: number) => void
  readonly registerFindTarget: RegisterViewerFindTarget
  readonly documentReview?: DocumentReviewDocumentProjection
}): ReactElement {
  const theme = useAppTheme()
  const pathKey = `${path.hostId}:${path.path}`
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const applyingExternal = useRef(false)
  const lastUserContent = useRef<string | undefined>(undefined)
  const highlightInputs = useRef<
    { pathKey: string; theme: 'dark' | 'light' } | undefined
  >(undefined)
  const callbacks = useRef({ onContent, onSave, onPosition })
  const [highlightStatus, setHighlightStatus] = useState('')
  const blameCompartment = useRef(new Compartment())
  const reviewCompartment = useRef(new Compartment())
  const reviewProjection = useRef(documentReview)
  const registerReviewInlineHost = useDocumentReviewInlineHostRegistration()
  callbacks.current = { onContent, onSave, onPosition }
  reviewProjection.current = documentReview

  useEffect(() => {
    const parent = container.current
    if (!parent) return
    lastUserContent.current = undefined
    const targetRef: { current?: CodeMirrorFindTarget } = {}
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers({
            domEventHandlers: {
              mousedown(view, block, event) {
                const review = reviewProjection.current
                if (
                  !review?.active ||
                  review.dirty ||
                  !(event instanceof MouseEvent) ||
                  event.button !== 0
                ) {
                  return false
                }
                event.preventDefault()
                const line = view.state.doc.lineAt(block.from).number
                review.onCapture({ startLine: line, endLine: line })
                return true
              },
            },
          }),
          blameCompartment.current.of(blameGutter(blame)),
          reviewCompartment.current.of([]),
          tokenDecorations,
          viewerFindDecorations,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                callbacks.current.onSave()
                return true
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) targetRef.current?.contentChanged()
            if (update.docChanged && !applyingExternal.current) {
              const next = update.state.doc.toString()
              lastUserContent.current = next
              callbacks.current.onContent(next)
            }
          }),
          sourceTheme,
        ],
      }),
    })
    const target = new CodeMirrorFindTarget([{ view: editor }])
    targetRef.current = target
    const unregisterFind = registerFindTarget(target)
    const restorePosition = position
    const capturePosition = (): ViewerDocumentPosition => ({
      mode: 'source',
      line: captureTopLine(editor, editor.scrollDOM),
      scrollTop: editor.scrollDOM.scrollTop,
    })
    positionCapture.current = capturePosition
    const captureScroll = (): void => {
      callbacks.current.onPosition(capturePosition())
    }
    editor.scrollDOM.addEventListener('scroll', captureScroll, { passive: true })
    view.current = editor
    restoreCodePosition(editor, editor.scrollDOM, restorePosition, 'source')
    return () => {
      editor.scrollDOM.removeEventListener('scroll', captureScroll)
      if (positionCapture.current === capturePosition) {
        positionCapture.current = undefined
      }
      view.current = undefined
      unregisterFind()
      target.clear()
      targetRef.current = undefined
      editor.destroy()
    }
    // A path change is a new editor. Content synchronization is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey])

  useEffect(() => {
    if (!navigation) return
    const frame = requestAnimationFrame(() => {
      const editor = view.current
      if (!editor) return
      const resolved = resolveSourceCoordinate(editor.state.doc.toString(), navigation)
      if (!resolved.valid) {
        onNavigationHandled(navigation.serial)
        return
      }
      editor.dispatch({
        selection: { anchor: resolved.offset },
        effects: EditorView.scrollIntoView(resolved.offset, { y: 'center' }),
      })
      if (navigation.focus) editor.focus()
      onNavigationHandled(navigation.serial)
    })
    return () => cancelAnimationFrame(frame)
  }, [navigation, onNavigationHandled, pathKey])

  useEffect(() => {
    view.current?.dispatch({
      effects: blameCompartment.current.reconfigure(blameGutter(blame)),
    })
  }, [blame, pathKey])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: reviewCompartment.current.reconfigure(
        createDocumentReviewSourceExtensions(
          documentReview
            ? {
                active: documentReview.active,
                dirty: documentReview.dirty,
                comments: documentReview.comments,
                inlineRange: documentReview.inlineRange,
                onInlineHost: registerReviewInlineHost,
                onRange: documentReview.onSourceRange,
                onCapture: documentReview.onCapture,
                onOpenComment: documentReview.onOpenComment,
                onExit: documentReview.onExit,
              }
            : undefined,
        ),
      ),
    })
    documentReview?.onSourceRange(
      documentReview.active ? sourceReviewSelection(editor.state) : undefined,
    )
  }, [documentReview, registerReviewInlineHost, pathKey])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    const previousInputs = highlightInputs.current
    // Consume only the immediate parent echo of this editor's edit. Its UTF-8 size
    // can change; a new document or theme still needs its own highlight request.
    const userAuthored =
      lastUserContent.current === content &&
      previousInputs?.pathKey === pathKey &&
      previousInputs.theme === theme
    lastUserContent.current = undefined
    highlightInputs.current = { pathKey, theme }
    if (current !== content) {
      applyingExternal.current = true
      try {
        editor.dispatch({
          changes: { from: 0, to: current.length, insert: content },
          effects: [resetTokens.of(null), editor.scrollSnapshot()],
        })
      } finally {
        applyingExternal.current = false
      }
    }
    if (userAuthored) return
    return highlightSource(editor, path, content, size, theme, setHighlightStatus)
    // Path identity is host-qualified; equivalent path objects keep the request alive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, pathKey, size, theme])

  return (
    <div className="source-shell">
      <div className="source-meta">
        <span>{formatViewerBytes(size)}</span>
        <span>{highlightStatus}</span>
        <span>{blameStatus}</span>
      </div>
      <div ref={container} className="codemirror-host" />
    </div>
  )
}

const sourceTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--viewer-bg)', color: 'var(--text)' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--hvir-monospace-font)',
    fontSize: 'calc(13px * var(--hvir-interface-scale))',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--viewer-gutter)',
    borderRight: '1px solid var(--code-border)',
    color: 'var(--viewer-gutter-text)',
  },
  '&.cm-focused': { outline: 'none' },
})
