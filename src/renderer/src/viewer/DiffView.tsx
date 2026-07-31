import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

import {
  diffPreview,
  selectDiffWorkload,
  textLineCount,
  type DiffBase,
  type DiffWorkloadSelection,
  type GitDiffResponse,
  type HostPath,
  type TextWorkload,
} from '../../../shared'
import { captureTopLine, restoreCodePosition } from './code-scroll-anchor'
import { CodeMirrorFindTarget, viewerFindDecorations } from './codemirror-find-target'
import { shouldPublishDiffPosition, usesUnsavedContent } from './diff-policy'
import type { ViewerDocumentPosition } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import type { ViewerPositionCapture } from './viewer-position'

interface DiffViewProps {
  readonly path: HostPath
  readonly base: DiffBase
  readonly currentContent: string
  readonly currentSize: number
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
  currentSize,
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
    if (!parent || !inputs || !currentInput || workload?.kind !== 'interactive') return
    const extensions = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      viewerFindDecorations,
      diffTheme,
    ]
    const merge = new MergeView({
      parent,
      a: { doc: inputs.baseInput.content, extensions },
      b: {
        doc: currentInput.content,
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
      merge.destroy()
    }
  }, [currentInput, inputs, positionCapture, registerFindTarget, workload?.kind])

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!inputs || !currentInput || !workload) {
    return <div className="viewer-empty">Preparing diff…</div>
  }
  if (workload.kind === 'fallback') {
    return (
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
    )
  }
  return (
    <div className="diff-shell">
      <div className="diff-labels">
        <span>{inputs.baseLabel}</span>
        <span>
          {inputs.currentLabel}
          {showUnsaved ? ' (unsaved)' : ''}
        </span>
      </div>
      <div className="diff-host" ref={host} />
    </div>
  )
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
