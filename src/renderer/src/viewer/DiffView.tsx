import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { formatViewerBytes } from './viewer-byte-format'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import {
  textLineCount,
  type DiffBase,
  type HostPath,
  type TextWorkload,
} from '../../../shared'
import { useAppTheme } from '../theme'
import {
  diffGroupBoundaries,
  diffTheme,
  registerDiffContextControls,
} from './diff-presentation'
import { highlightSource, resetTokens, tokenDecorations } from './source-highlighting'
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
      <div className={`viewer-empty${error ? ' error' : ''}` + ' hvir-state'}>
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
      path={path}
      baseSize={inputs.baseInput.byteLength}
      currentSize={currentInput.byteLength}
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
  path,
  baseSize,
  currentSize,
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
  readonly path: HostPath
  readonly baseSize: number
  readonly currentSize: number
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
  const theme = useAppTheme()
  const pathKey = `${path.hostId}:${path.path}`
  const [wrapLines, setWrapLines] = useState(true)
  const themeCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())
  const [baseStatus, setBaseStatus] = useState('')
  const [currentStatus, setCurrentStatus] = useState('')
  const presentationRef = useRef({ theme, wrapLines })
  presentationRef.current = { theme, wrapLines }
  const host = useRef<HTMLDivElement>(null)
  const [editors, setEditors] = useState<{ readonly merge: MergeView; active: boolean }>()
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
      tokenDecorations,
      viewerFindDecorations,
      diffGroupBoundaries,
      themeCompartment.current.of(diffTheme(presentationRef.current.theme)),
      wrapCompartment.current.of(
        presentationRef.current.wrapLines ? EditorView.lineWrapping : [],
      ),
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
    const editors = { merge, active: true }
    setEditors(editors)
    const unregisterContextControls = registerDiffContextControls(merge.dom)
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
      // Effects may receive changed inputs in the same commit that replaces these editors.
      editors.active = false
      merge.dom.removeEventListener('scroll', captureScroll)
      merge.dom.removeEventListener('pointerdown', markNavigation)
      merge.dom.removeEventListener('touchstart', markNavigation)
      merge.dom.removeEventListener('wheel', markNavigation)
      merge.dom.removeEventListener('keydown', markKeyboardNavigation)
      if (positionCapture.current === capturePosition) {
        positionCapture.current = undefined
      }
      unregisterContextControls()
      unregisterFind()
      findTarget.clear()
      merge.destroy()
    }
  }, [positionCapture, registerFindTarget])

  useEffect(() => {
    if (!editors?.active) return
    const { merge } = editors
    replaceDocument(merge.a, baseContent)
    replaceDocument(merge.b, currentContent)
  }, [editors, baseContent, currentContent])

  useEffect(() => {
    if (!editors?.active) return
    const { merge } = editors
    for (const view of [merge.a, merge.b]) {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(diffTheme(theme)),
      })
    }
  }, [editors, theme])

  useEffect(() => {
    if (!editors?.active) return
    const { merge } = editors
    for (const view of [merge.a, merge.b]) {
      view.dispatch({
        effects: wrapCompartment.current.reconfigure(
          wrapLines ? EditorView.lineWrapping : [],
        ),
      })
    }
  }, [editors, wrapLines])

  useEffect(() => {
    if (!editors?.active) return
    const view = editors.merge.a
    return highlightSource(view, path, baseContent, baseSize, theme, setBaseStatus)
    // Equivalent host-qualified path objects do not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editors, pathKey, baseContent, baseSize, theme])

  useEffect(() => {
    if (!editors?.active) return
    const view = editors.merge.b
    return highlightSource(
      view,
      path,
      currentContent,
      currentSize,
      theme,
      setCurrentStatus,
    )
    // Equivalent host-qualified path objects do not restart the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editors, pathKey, currentContent, currentSize, theme])

  return (
    <div className="diff-shell">
      <DiffRefreshError error={error} />
      <div className="diff-controls">
        <button
          type="button"
          aria-pressed={wrapLines}
          onClick={() => setWrapLines(!wrapLines)}
          className="hvir-button"
        >
          Wrap lines
        </button>
      </div>
      <div className="diff-labels">
        <span title={baseLabel} aria-label={`Before: ${baseLabel}`}>
          <span className="diff-side-marker" aria-hidden="true">
            −
          </span>
          <span>{baseLabel}</span>
          <small title={baseStatus}>{baseStatus}</small>
        </span>
        <span title={currentLabel} aria-label={`After: ${currentLabel}`}>
          <span className="diff-side-marker" aria-hidden="true">
            +
          </span>
          <span>{currentLabel}</span>
          <small title={currentStatus}>{currentStatus}</small>
        </span>
      </div>
      <div className="diff-host" ref={host} />
    </div>
  )
}

function replaceDocument(view: EditorView, content: string): void {
  if (view.state.doc.toString() === content) return
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    effects: resetTokens.of(null),
  })
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
          {formatViewerBytes(input.byteLength)} included
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
