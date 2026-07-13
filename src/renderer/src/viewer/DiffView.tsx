import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { DiffBase, GitDiffResponse, HostPath } from '../../../shared'
import { usesUnsavedContent } from './diff-policy'

interface DiffViewProps {
  readonly path: HostPath
  readonly base: DiffBase
  readonly currentContent: string
  readonly dirty: boolean
  readonly revision?: string
  readonly refreshVersion: number
  readonly scrollTop: number
  readonly onScroll: (scrollTop: number) => void
}

export function DiffView({
  path,
  base,
  currentContent,
  dirty,
  revision,
  refreshVersion,
  scrollTop,
  onScroll,
}: DiffViewProps): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(scrollTop)
  const onScrollRef = useRef(onScroll)
  const [inputs, setInputs] = useState<GitDiffResponse>()
  const [error, setError] = useState<string>()
  scrollTopRef.current = scrollTop
  onScrollRef.current = onScroll

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
    const handleScroll = (): void => onScrollRef.current(merge.dom.scrollTop)
    merge.dom.addEventListener('scroll', handleScroll, { passive: true })
    const restoreFrame = requestAnimationFrame(() => {
      merge.dom.scrollTop = scrollTopRef.current
    })
    return () => {
      cancelAnimationFrame(restoreFrame)
      onScrollRef.current(merge.dom.scrollTop)
      merge.dom.removeEventListener('scroll', handleScroll)
      merge.destroy()
    }
  }, [base, currentContent, dirty, inputs, revision])

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
  '&': { height: '100%', backgroundColor: '#15181e', color: '#d4d7dd' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    fontSize: '12px',
    lineHeight: '1.5',
  },
  '.cm-gutters': {
    backgroundColor: '#15181e',
    borderRight: '1px solid #242933',
    color: '#5f6877',
  },
})
