import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { DiffBase, GitDiffResponse, HostPath } from '../../../shared'

interface DiffViewProps {
  readonly path: HostPath
  readonly base: DiffBase
  readonly currentContent: string
  readonly dirty: boolean
  readonly revision?: string
}

export function DiffView({
  path,
  base,
  currentContent,
  dirty,
  revision,
}: DiffViewProps): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [inputs, setInputs] = useState<GitDiffResponse>()
  const [error, setError] = useState<string>()

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
  }, [base, path, revision])

  useEffect(() => {
    const parent = host.current
    if (!parent || !inputs) return
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
        doc: dirty ? currentContent : inputs.currentContent,
        extensions,
      },
      collapseUnchanged: { margin: 3, minSize: 8 },
      highlightChanges: true,
      gutter: true,
    })
    return () => merge.destroy()
  }, [currentContent, dirty, inputs])

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!inputs) return <div className="viewer-empty">Preparing diff…</div>
  return (
    <div className="diff-shell">
      <div className="diff-labels">
        <span>{inputs.baseLabel}</span>
        <span>
          {inputs.currentLabel}
          {dirty ? ' (unsaved)' : ''}
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
