import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'

import {
  textLineCount,
  type DiffBase,
  type HostPath,
  type TextWorkload,
} from '../../../shared'
import { captureTopLine, restoreCodePosition } from './code-scroll-anchor'
import { CodeMirrorFindTarget, viewerFindDecorations } from './codemirror-find-target'
import { diffInputContextKey, useDiffInputs } from './use-diff-inputs'
import { shouldPublishDiffPosition, usesUnsavedContent } from './diff-policy'
import type { ViewerDocumentPosition } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import type { ViewerPositionCapture } from './viewer-position'
import {
  diffPreview,
  selectDiffWorkload,
  type DiffWorkloadSelection,
} from './viewer-workload-policy'

interface DiffViewProps {
  readonly path: HostPath
  readonly base: DiffBase
  readonly currentContent: string
  readonly currentSize: number
  readonly dirty: boolean
  readonly revision?: string
  readonly documentRefreshVersion: number
  readonly gitRefreshVersion: number
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly registerFindTarget: RegisterViewerFindTarget
}

export function DiffView({
  path,
  base,
  currentContent,
  currentSize,
  dirty,
  revision,
  documentRefreshVersion,
  gitRefreshVersion,
  position,
  onPosition,
  positionCapture,
  registerFindTarget,
}: DiffViewProps): ReactElement {
  const contextKey = diffInputContextKey(path, base, revision)
  const { inputs, error } = useDiffInputs({
    contextKey,
    path,
    base,
    revision,
    documentRefreshVersion,
    gitRefreshVersion,
  })
  const showUnsaved = usesUnsavedContent(dirty, base, revision)
  const currentInput = useMemo(
    () =>
      inputs
        ? showUnsaved
          ? liveInput(currentContent, currentSize)
          : inputs.currentInput
        : undefined,
    [currentContent, currentSize, inputs, showUnsaved],
  )
  const workload =
    inputs && currentInput
      ? selectDiffWorkload(inputs.baseInput, currentInput)
      : undefined
  if (!inputs || !currentInput || !workload) {
    return (
      <div className={`viewer-empty${error ? ' error' : ''}`}>
        {error ?? 'Preparing diff…'}
      </div>
    )
  }
  if (workload.kind === 'fallback') {
    return (
      <div className="diff-shell">
        <DiffRefreshError error={error} />
        <DiffFallback
          path={path}
          base={base}
          revision={revision}
          baseLabel={inputs.baseLabel}
          currentLabel={`${inputs.currentLabel}${showUnsaved ? ' (unsaved)' : ''}`}
          baseInput={inputs.baseInput}
          currentInput={currentInput}
          workload={workload}
        />
      </div>
    )
  }
  return (
    <InteractiveDiff
      key={contextKey}
      baseLabel={inputs.baseLabel}
      currentLabel={`${inputs.currentLabel}${showUnsaved ? ' (unsaved)' : ''}`}
      baseContent={inputs.baseInput.content}
      currentContent={currentInput.content}
      error={error}
      position={position}
      onPosition={onPosition}
      positionCapture={positionCapture}
      registerFindTarget={registerFindTarget}
    />
  )
}

function InteractiveDiff({
  baseLabel,
  currentLabel,
  baseContent,
  currentContent,
  error,
  position,
  onPosition,
  positionCapture,
  registerFindTarget,
}: {
  readonly baseLabel: string
  readonly currentLabel: string
  readonly baseContent: string
  readonly currentContent: string
  readonly error?: string
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const mergeRef = useRef<MergeView | undefined>(undefined)
  const contentRef = useRef({ base: baseContent, current: currentContent })
  const positionRef = useRef(position)
  const onPositionRef = useRef(onPosition)
  contentRef.current = { base: baseContent, current: currentContent }
  positionRef.current = position
  onPositionRef.current = onPosition

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const extensions = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      viewerFindDecorations,
      diffTheme,
    ]
    const merge = new MergeView({
      parent,
      a: { doc: contentRef.current.base, extensions },
      b: {
        doc: contentRef.current.current,
        extensions,
      },
      collapseUnchanged: { margin: 3, minSize: 8 },
      highlightChanges: true,
      gutter: true,
    })
    mergeRef.current = merge
    const findTarget = new CodeMirrorFindTarget(
      [
        { view: merge.a, side: 'base' },
        { view: merge.b, side: 'current' },
      ],
      { revealMatches: () => merge.reconfigure({ collapseUnchanged: undefined }) },
    )
    const unregisterFind = registerFindTarget(findTarget)
    const restorePosition = positionRef.current
    let userNavigated = false
    const captureVisiblePosition = (): ViewerDocumentPosition => ({
      mode: 'diff',
      line: captureTopLine(merge.b, merge.dom),
      scrollTop: merge.dom.scrollTop,
    })
    const capturePosition = (): ViewerDocumentPosition =>
      shouldPublishDiffPosition(merge.chunks.length > 0, userNavigated)
        ? captureVisiblePosition()
        : positionRef.current
    positionCapture.current = capturePosition
    const captureScroll = (): void => {
      if (shouldPublishDiffPosition(merge.chunks.length > 0, userNavigated)) {
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
    restoreCodePosition(merge.b, merge.dom, restorePosition, 'diff')
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
      mergeRef.current = undefined
      merge.destroy()
    }
  }, [positionCapture, registerFindTarget])

  useEffect(() => {
    const merge = mergeRef.current
    if (!merge) return
    replaceDocument(merge.a, baseContent)
    replaceDocument(merge.b, currentContent)
  }, [baseContent, currentContent])

  return (
    <div className="diff-shell">
      <DiffRefreshError error={error} />
      <div className="diff-labels">
        <span>{baseLabel}</span>
        <span>{currentLabel}</span>
      </div>
      <div className="diff-host" ref={host} />
    </div>
  )
}

function replaceDocument(view: EditorView, content: string): void {
  if (view.state.doc.toString() === content) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
}

function DiffRefreshError({ error }: { readonly error?: string }): ReactElement | null {
  return error ? (
    <div className="diff-refresh-error" role="alert">
      Diff refresh failed: {error}
    </div>
  ) : null
}

function liveInput(content: string, byteLength: number): TextWorkload {
  return {
    content,
    byteLength,
    lineCount: textLineCount(content),
    complete: true,
  }
}

function DiffFallback({
  path,
  base,
  revision,
  baseLabel,
  currentLabel,
  baseInput,
  currentInput,
  workload,
}: {
  readonly path: HostPath
  readonly base: DiffBase
  readonly revision?: string
  readonly baseLabel: string
  readonly currentLabel: string
  readonly baseInput: TextWorkload
  readonly currentInput: TextWorkload
  readonly workload: Extract<DiffWorkloadSelection, { readonly kind: 'fallback' }>
}): ReactElement {
  return (
    <section className="diff-fallback" aria-label="Bounded diff preview">
      <header>
        <strong>Diff preview limited</strong>
        <span>{fallbackReason(workload.reason)}</span>
        <span className="diff-fallback-path">{path.path}</span>
        <span>Requested comparison: {requestedComparison(base, revision)}</span>
      </header>
      <div className="diff-fallback-inputs">
        <DiffFallbackInput label={baseLabel} input={baseInput} />
        <DiffFallbackInput label={currentLabel} input={currentInput} />
      </div>
    </section>
  )
}

function DiffFallbackInput({
  label,
  input,
}: {
  readonly label: string
  readonly input: TextWorkload
}): ReactElement {
  const preview = diffPreview(input.content)
  const previewBounded = preview.length < input.content.length
  return (
    <section className="diff-fallback-side">
      <div className="diff-fallback-meta">
        <strong>{label}</strong>
        <span>
          {input.complete ? 'complete input' : 'partial input'}
          {' · '}
          {formatBytes(input.byteLength)} included
          {' · '}
          {input.lineCount.toLocaleString()} included lines
          {previewBounded ? ' · preview bounded' : ''}
        </span>
      </div>
      <pre>{preview}</pre>
    </section>
  )
}

function fallbackReason(
  reason: Extract<DiffWorkloadSelection, { readonly kind: 'fallback' }>['reason'],
): string {
  if (reason === 'incomplete-input') {
    return 'At least one Git input was truncated; an incomplete comparison is not shown.'
  }
  if (reason === 'line-limit') {
    return 'The complete inputs exceed the interactive diff line budget.'
  }
  return 'The complete inputs exceed the interactive diff byte budget.'
}

function requestedComparison(base: DiffBase, revision?: string): string {
  if (revision) return `${revision.slice(0, 8)}^ → ${revision.slice(0, 8)}`
  if (base === 'working-tree') return 'Index → Working tree'
  if (base === 'branch-point') return 'Branch point → HEAD'
  return 'HEAD → Working tree'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
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
