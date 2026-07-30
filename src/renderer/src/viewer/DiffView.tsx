import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { DiffBase, GitDiffResponse, HostPath } from '../../../shared'
import { captureTopLine, restoreScrollTop, restoreTopLine } from './code-scroll-anchor'
import { CodeMirrorFindTarget, viewerFindDecorations } from './codemirror-find-target'
import { shouldPublishDiffPosition, usesUnsavedContent } from './diff-policy'
import type { ViewerDocumentPosition } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import type { ViewerPositionCapture } from './viewer-position'

interface DiffViewProps {
  readonly path: HostPath
  readonly base: DiffBase
  readonly currentContent: string
  readonly dirty: boolean
  readonly revision?: string
  readonly refreshVersion: number
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly registerFindTarget: RegisterViewerFindTarget
}

export function DiffView({
  path,
  base,
  currentContent,
  dirty,
  revision,
  refreshVersion,
  position,
  onPosition,
  positionCapture,
  registerFindTarget,
}: DiffViewProps): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const positionRef = useRef(position)
  const onPositionRef = useRef(onPosition)
  const [inputs, setInputs] = useState<GitDiffResponse>()
  const [error, setError] = useState<string>()
  positionRef.current = position
  onPositionRef.current = onPosition

  useEffect(() => {
    let cancelled = false
    setInputs(undefined)
    setError(undefined)
    void window.hvir.invoke('git:diff-inputs', { path, base, revision }).then(
      (result) => {
        if (!cancelled) setInputs(result)
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [base, path, refreshVersion, revision])

  useEffect(() => {
    const parent = host.current
    if (!parent || !inputs) return
    const showUnsaved = usesUnsavedContent(dirty, base, revision)
    const extensions = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      viewerFindDecorations,
      diffTheme,
    ]
    const merge = new MergeView({
      parent,
      a: { doc: inputs.baseContent, extensions },
      b: {
        doc: showUnsaved ? currentContent : inputs.currentContent,
        extensions,
      },
      collapseUnchanged: { margin: 3, minSize: 8 },
      highlightChanges: true,
      gutter: true,
    })
    const findTarget = new CodeMirrorFindTarget(
      [
        { view: merge.a, side: 'base' },
        { view: merge.b, side: 'current' },
      ],
      { revealMatches: () => merge.reconfigure({ collapseUnchanged: undefined }) },
    )
    const unregisterFind = registerFindTarget(findTarget)
    const restorePosition = positionRef.current
    const hasChanges = merge.chunks.length > 0
    let userNavigated = false
    const captureVisiblePosition = (): ViewerDocumentPosition => ({
      mode: 'diff',
      line: captureTopLine(merge.b, merge.dom),
      scrollTop: merge.dom.scrollTop,
    })
    const capturePosition = (): ViewerDocumentPosition =>
      shouldPublishDiffPosition(hasChanges, userNavigated)
        ? captureVisiblePosition()
        : positionRef.current
    positionCapture.current = capturePosition
    const captureScroll = (): void => {
      if (shouldPublishDiffPosition(hasChanges, userNavigated)) {
        onPositionRef.current(captureVisiblePosition())
      }
    }
    const markNavigation = (): void => {
      userNavigated = true
    }
    const markKeyboardNavigation = (event: KeyboardEvent): void => {
      if (DIFF_NAVIGATION_KEYS.has(event.key)) markNavigation()
    }
    merge.dom.addEventListener('scroll', captureScroll, { passive: true })
    merge.dom.addEventListener('pointerdown', markNavigation)
    merge.dom.addEventListener('touchstart', markNavigation, { passive: true })
    merge.dom.addEventListener('wheel', markNavigation, { passive: true })
    merge.dom.addEventListener('keydown', markKeyboardNavigation)
    if (restorePosition.mode === 'diff') {
      restoreScrollTop(merge.b, merge.dom, restorePosition.scrollTop)
    } else restoreTopLine(merge.b, merge.dom, restorePosition.line)
    return () => {
      merge.dom.removeEventListener('scroll', captureScroll)
      merge.dom.removeEventListener('pointerdown', markNavigation)
      merge.dom.removeEventListener('touchstart', markNavigation)
      merge.dom.removeEventListener('wheel', markNavigation)
      merge.dom.removeEventListener('keydown', markKeyboardNavigation)
      if (positionCapture.current === capturePosition) {
        positionCapture.current = undefined
      }
      unregisterFind()
      findTarget.clear()
      merge.destroy()
    }
  }, [base, currentContent, dirty, inputs, positionCapture, registerFindTarget, revision])

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!inputs) return <div className="viewer-empty">Preparing diff…</div>
  return (
    <div className="diff-shell">
      <div className="diff-labels">
        <span>{inputs.baseLabel}</span>
        <span>
          {inputs.currentLabel}
          {usesUnsavedContent(dirty, base, revision) ? ' (unsaved)' : ''}
        </span>
      </div>
      <div className="diff-host" ref={host} />
    </div>
  )
}

const diffTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--viewer-bg)', color: 'var(--text)' },
  '.cm-scroller': {
    fontFamily: 'var(--hvir-monospace-font)',
    fontSize: 'calc(12px * var(--hvir-interface-scale))',
    lineHeight: '1.5',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--viewer-gutter)',
    borderRight: '1px solid var(--code-border)',
    color: 'var(--viewer-gutter-text)',
  },
})

const DIFF_NAVIGATION_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
])
