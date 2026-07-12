import { StateEffect, StateField, EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { basenameHostPath, type ReadFileResponse } from '../../../shared'
import type {
  HighlightLanguage,
  HighlightResponse,
  HighlightToken,
} from './highlight-protocol'

export const HIGHLIGHT_SIZE_LIMIT = 1024 * 1024

let sharedHighlightWorker: Worker | undefined
let nextHighlightRequestId = 0

function getHighlightWorker(): Worker {
  sharedHighlightWorker ??= new Worker(
    new URL('./highlight.worker.ts', import.meta.url),
    { type: 'module' },
  )
  return sharedHighlightWorker
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sharedHighlightWorker?.terminate()
    sharedHighlightWorker = undefined
  })
}

const addTokens = StateEffect.define<readonly HighlightToken[]>()
const tokenDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(addTokens)) continue
      const additions = effect.value
        .filter(
          (token) =>
            token.from >= 0 &&
            token.to > token.from &&
            token.to <= transaction.state.doc.length,
        )
        .map((token) =>
          Decoration.mark({ attributes: { style: tokenStyle(token) } }).range(
            token.from,
            token.to,
          ),
        )
      next = next.update({ add: additions, sort: true })
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

interface FileViewerProps {
  readonly file?: ReadFileResponse
  readonly loading: boolean
  readonly error?: string
}

export function FileViewer({ file, loading, error }: FileViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [highlightStatus, setHighlightStatus] = useState('')

  useEffect(() => {
    const container = containerRef.current
    if (!container || !file || file.binary) return

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: file.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          tokenDecorations,
          keymap.of([]),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: '#15181e', color: '#d4d7dd' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
              fontSize: '13px',
              lineHeight: '1.55',
            },
            '.cm-content': { padding: '12px 0', caretColor: 'transparent' },
            '.cm-gutters': {
              backgroundColor: '#15181e',
              borderRight: '1px solid #242933',
              color: '#5f6877',
            },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
          }),
        ],
      }),
    })

    const language = languageFor(file.path.path)
    if (file.size > HIGHLIGHT_SIZE_LIMIT) {
      setHighlightStatus('large file · highlighting off')
      return () => view.destroy()
    }
    if (!language) {
      setHighlightStatus('plain text')
      return () => view.destroy()
    }

    setHighlightStatus('highlighting…')
    const worker = getHighlightWorker()
    const requestId = ++nextHighlightRequestId
    const onMessage = (event: MessageEvent<HighlightResponse>): void => {
      const message = event.data
      if (message.id !== requestId) return
      if (message.type === 'batch') {
        view.dispatch({ effects: addTokens.of(message.tokens) })
      } else if (message.type === 'done') {
        setHighlightStatus(language)
      } else {
        setHighlightStatus(`highlight failed: ${message.message}`)
      }
    }
    const onError = (event: ErrorEvent): void => {
      setHighlightStatus(`highlight worker failed: ${event.message}`)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ id: requestId, code: file.content, language })

    return () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      view.destroy()
    }
  }, [file])

  const size = file ? formatBytes(file.size) : ''
  return (
    <section className="viewer-panel" aria-label="File viewer">
      <header className="panel-header">
        <span>{file ? basenameHostPath(file.path) : 'Viewer'}</span>
        <span className="panel-meta">
          {[size, highlightStatus].filter(Boolean).join(' · ')}
        </span>
      </header>
      <div className="viewer-body">
        {loading ? <EmptyViewer text="Opening…" /> : null}
        {!loading && error ? <EmptyViewer text={error} error /> : null}
        {!loading && !error && !file ? (
          <EmptyViewer text="Choose a file from the tree" />
        ) : null}
        {!loading && !error && file?.binary ? (
          <EmptyViewer text="Binary files are not rendered" />
        ) : null}
        <div
          ref={containerRef}
          className="codemirror-host"
          hidden={loading || Boolean(error) || !file || file.binary}
        />
      </div>
    </section>
  )
}

function EmptyViewer({
  text,
  error = false,
}: {
  text: string
  error?: boolean
}): ReactElement {
  return <div className={`viewer-empty${error ? ' error' : ''}`}>{text}</div>
}

function languageFor(path: string): HighlightLanguage | undefined {
  const name = path.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const byExtension: Record<string, HighlightLanguage> = {
    bash: 'bash',
    css: 'css',
    go: 'go',
    htm: 'html',
    html: 'html',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'tsx',
  }
  return byExtension[extension]
}

function tokenStyle(token: HighlightToken): string {
  const declarations: string[] = []
  if (token.color) declarations.push(`color:${token.color}`)
  if (token.backgroundColor)
    declarations.push(`background-color:${token.backgroundColor}`)
  if (token.fontStyle) {
    if ((token.fontStyle & 1) !== 0) declarations.push('font-style:italic')
    if ((token.fontStyle & 2) !== 0) declarations.push('font-weight:700')
    const lines: string[] = []
    if ((token.fontStyle & 4) !== 0) lines.push('underline')
    if ((token.fontStyle & 8) !== 0) lines.push('line-through')
    if (lines.length > 0) declarations.push(`text-decoration:${lines.join(' ')}`)
  }
  return declarations.join(';')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
