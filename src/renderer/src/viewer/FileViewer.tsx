import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  basenameHostPath,
  canRender,
  type DiffBase,
  type ViewMode,
  type GitBlameRun,
  type HostPath,
} from '../../../shared'
import { DiffView } from './DiffView'
import type {
  HighlightLanguage,
  HighlightResponse,
  HighlightToken,
} from './highlight-protocol'
import { RenderedView } from './RenderedView'
import type { ViewerTab } from './tab-state'

export const HIGHLIGHT_SIZE_LIMIT = 1024 * 1024
export const CODEMIRROR_SIZE_LIMIT = 5 * 1024 * 1024
const LARGE_FILE_PREVIEW_LIMIT = 512 * 1024

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
const resetTokens = StateEffect.define<null>()
const tokenDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(resetTokens)) next = Decoration.none
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
  readonly tab?: ViewerTab
  readonly onMode: (mode: ViewMode) => void
  readonly onDiffBase: (base: DiffBase) => void
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onReload: () => void
  readonly onScroll: (scrollTop: number) => void
  readonly onOpenPath: (path: HostPath) => void
  readonly refreshVersion: number
}

export function FileViewer({
  tab,
  onMode,
  onDiffBase,
  onContent,
  onSave,
  onReload,
  onScroll,
  onOpenPath,
  refreshVersion,
}: FileViewerProps): ReactElement {
  const [showBlame, setShowBlame] = useState(false)
  const [blame, setBlame] = useState<readonly GitBlameRun[]>([])
  const [blameStatus, setBlameStatus] = useState('')
  const currentPath = tab?.path
  const blameMode = tab?.mode

  useEffect(() => {
    if (!showBlame || !currentPath || blameMode !== 'source') return
    let cancelled = false
    setBlame([])
    setBlameStatus('blame loading…')
    void window.hvir.invoke('git:blame', { path: currentPath }).then(
      (runs) => {
        if (!cancelled) {
          setBlame(runs)
          setBlameStatus(
            `${runs.reduce((total, run) => total + run.lineCount, 0)} blamed lines · ${runs.length} runs`,
          )
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setBlame([])
          setBlameStatus(
            `blame unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
          )
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [blameMode, currentPath, refreshVersion, showBlame])

  return (
    <>
      <header className="viewer-toolbar">
        <div className="viewer-title">
          {tab ? basenameHostPath(tab.path) : 'No file open'}
          {tab?.conflict ? (
            <button className="conflict-badge" type="button" onClick={onReload}>
              Changed on disk · reload
            </button>
          ) : null}
          {tab?.error && tab.file ? (
            <span className="viewer-operation-error" role="status" title={tab.error}>
              Save failed
            </span>
          ) : null}
        </div>
        {tab ? (
          <div className="view-controls">
            {tab.mode === 'diff' && !tab.diffRevision ? (
              <select
                className="diff-base-select"
                aria-label="Diff base"
                value={tab.diffBase}
                onChange={(event) => onDiffBase(event.currentTarget.value as DiffBase)}
              >
                <option value="working-tree">Index</option>
                <option value="head">HEAD</option>
                <option value="branch-point">Branch point</option>
              </select>
            ) : null}
            {tab.mode === 'source' ? (
              <button
                type="button"
                className={`blame-toggle${showBlame ? ' active' : ''}`}
                aria-pressed={showBlame}
                onClick={() => setShowBlame((shown) => !shown)}
              >
                Blame
              </button>
            ) : null}
            <div className="mode-control" aria-label="View mode">
              {(['rendered', 'source', 'diff'] as const).map((mode) => (
                <button
                  type="button"
                  className={tab.mode === mode ? 'active' : ''}
                  aria-pressed={tab.mode === mode}
                  title={
                    mode === 'rendered' && !canRender(tab.path)
                      ? 'No renderer registered for this file type'
                      : `${mode} view · Ctrl/Cmd+Shift+M cycles modes`
                  }
                  key={mode}
                  onClick={() => onMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </header>
      <div className="viewer-body">
        {!tab ? <EmptyViewer text="Choose a file from the tree" /> : null}
        {tab?.loading ? <EmptyViewer text="Opening…" /> : null}
        {tab?.error && !tab.file ? <EmptyViewer text={tab.error} error /> : null}
        {tab && !tab.loading && tab.file?.binary ? (
          <EmptyViewer text="Binary files are not rendered" />
        ) : null}
        {tab && !tab.loading && tab.file && !tab.file.binary ? (
          <ActiveView
            tab={tab}
            file={tab.file}
            onContent={onContent}
            onSave={onSave}
            onScroll={onScroll}
            blame={showBlame ? blame : []}
            blameStatus={showBlame ? blameStatus : ''}
            onOpenPath={onOpenPath}
            refreshVersion={refreshVersion}
          />
        ) : null}
      </div>
    </>
  )
}

function ActiveView({
  tab,
  file,
  onContent,
  onSave,
  onScroll,
  blame,
  blameStatus,
  onOpenPath,
  refreshVersion,
}: {
  readonly tab: ViewerTab
  readonly file: NonNullable<ViewerTab['file']>
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onScroll: (scrollTop: number) => void
  readonly blame: readonly GitBlameRun[]
  readonly blameStatus: string
  readonly onOpenPath: (path: HostPath) => void
  readonly refreshVersion: number
}): ReactElement {
  if (tab.mode === 'rendered') {
    return (
      <RenderedView
        path={tab.path}
        content={file.content}
        scrollTop={tab.scrollTop}
        onScroll={onScroll}
        onOpenPath={onOpenPath}
        refreshVersion={refreshVersion}
      />
    )
  }
  if (file.size > CODEMIRROR_SIZE_LIMIT) {
    return (
      <LargeFileView
        content={file.content}
        size={file.size}
        scrollTop={tab.scrollTop}
        onScroll={onScroll}
      />
    )
  }
  if (tab.mode === 'diff') {
    return (
      <DiffView
        path={tab.path}
        base={tab.diffBase}
        currentContent={file.content}
        dirty={tab.dirty}
        revision={tab.diffRevision}
        refreshVersion={refreshVersion}
        scrollTop={tab.scrollTop}
        onScroll={onScroll}
      />
    )
  }
  return (
    <SourceView
      pathKey={`${tab.path.hostId}:${tab.path.path}`}
      content={file.content}
      size={file.size}
      scrollTop={tab.scrollTop}
      onContent={onContent}
      onSave={onSave}
      onScroll={onScroll}
      blame={blame}
      blameStatus={blameStatus}
    />
  )
}

function LargeFileView({
  content,
  size,
  scrollTop,
  onScroll,
}: {
  readonly content: string
  readonly size: number
  readonly scrollTop: number
  readonly onScroll: (scrollTop: number) => void
}): ReactElement {
  const container = useRef<HTMLPreElement>(null)
  const initialScrollTop = useRef(scrollTop)
  const preview = content.slice(0, LARGE_FILE_PREVIEW_LIMIT)
  useEffect(() => {
    if (container.current) container.current.scrollTop = initialScrollTop.current
  }, [])
  return (
    <div className="large-file-shell">
      <div className="source-meta">
        <span>{formatBytes(size)}</span>
        <span>read-only preview · first {formatBytes(preview.length)}</span>
      </div>
      <pre
        ref={container}
        className="large-file-preview"
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      >
        {preview}
      </pre>
    </div>
  )
}

function SourceView({
  pathKey,
  content,
  size,
  scrollTop,
  onContent,
  onSave,
  onScroll,
  blame,
  blameStatus,
}: {
  readonly pathKey: string
  readonly content: string
  readonly size: number
  readonly scrollTop: number
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onScroll: (scrollTop: number) => void
  readonly blame: readonly GitBlameRun[]
  readonly blameStatus: string
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const applyingExternal = useRef(false)
  const lastUserContent = useRef<string | undefined>(undefined)
  const callbacks = useRef({ onContent, onSave, onScroll })
  const [highlightStatus, setHighlightStatus] = useState('')
  const blameCompartment = useRef(new Compartment())
  callbacks.current = { onContent, onSave, onScroll }

  useEffect(() => {
    const parent = container.current
    if (!parent) return
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          blameCompartment.current.of(blameGutter(blame)),
          tokenDecorations,
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
    const handleScroll = (): void => {
      callbacks.current.onScroll(editor.scrollDOM.scrollTop)
    }
    editor.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    view.current = editor
    requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = scrollTop
    })
    return () => {
      callbacks.current.onScroll(editor.scrollDOM.scrollTop)
      editor.scrollDOM.removeEventListener('scroll', handleScroll)
      view.current = undefined
      editor.destroy()
    }
    // A path change is a new editor. Content synchronization is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey])

  useEffect(() => {
    view.current?.dispatch({
      effects: blameCompartment.current.reconfigure(blameGutter(blame)),
    })
  }, [blame])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    const userAuthored = lastUserContent.current === content
    if (current !== content) {
      applyingExternal.current = true
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: content },
        effects: [resetTokens.of(null), editor.scrollSnapshot()],
      })
      applyingExternal.current = false
    }
    if (userAuthored) return
    return highlight(editor, pathKey, content, size, setHighlightStatus)
  }, [content, pathKey, size])

  return (
    <div className="source-shell">
      <div className="source-meta">
        <span>{formatBytes(size)}</span>
        <span>{highlightStatus}</span>
        <span>{blameStatus}</span>
      </div>
      <div ref={container} className="codemirror-host" />
    </div>
  )
}

class BlameMarker extends GutterMarker {
  constructor(private readonly run: GitBlameRun) {
    super()
  }
  override toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-blame-marker'
    element.textContent = `${this.run.hash.slice(0, 7)} ${this.run.author}`
    element.title = `${this.run.author} · ${this.run.summary}`
    return element
  }
}

function blameGutter(runs: readonly GitBlameRun[]) {
  if (runs.length === 0) return []
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(view, block) {
      const run = findBlameRun(runs, view.state.doc.lineAt(block.from).number)
      return run ? new BlameMarker(run) : null
    },
  })
}

function findBlameRun(
  runs: readonly GitBlameRun[],
  line: number,
): GitBlameRun | undefined {
  let low = 0
  let high = runs.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const run = runs[middle]
    if (!run) return undefined
    if (line < run.startLine) high = middle - 1
    else if (line >= run.startLine + run.lineCount) low = middle + 1
    else return run
  }
  return undefined
}

function highlight(
  view: EditorView,
  path: string,
  content: string,
  size: number,
  setStatus: (status: string) => void,
): () => void {
  view.dispatch({ effects: resetTokens.of(null) })
  if (size > HIGHLIGHT_SIZE_LIMIT) {
    setStatus('large file · highlighting off')
    return () => undefined
  }
  const language = languageFor(path)
  if (!language) {
    setStatus('plain text')
    return () => undefined
  }
  setStatus('highlighting…')
  const worker = getHighlightWorker()
  const requestId = ++nextHighlightRequestId
  const onMessage = (event: MessageEvent<HighlightResponse>): void => {
    const message = event.data
    if (message.id !== requestId) return
    if (message.type === 'batch') {
      view.dispatch({ effects: addTokens.of(message.tokens) })
    } else if (message.type === 'done') {
      setStatus(language)
    } else {
      setStatus(`highlight failed: ${message.message}`)
    }
  }
  const onError = (event: ErrorEvent): void => {
    setStatus(`highlight worker failed: ${event.message}`)
  }
  worker.addEventListener('message', onMessage)
  worker.addEventListener('error', onError)
  worker.postMessage({ id: requestId, code: content, language })
  return () => {
    worker.removeEventListener('message', onMessage)
    worker.removeEventListener('error', onError)
  }
}

function EmptyViewer({
  text,
  error = false,
}: {
  readonly text: string
  readonly error?: boolean
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

const sourceTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#15181e', color: '#d4d7dd' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    fontSize: '13px',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '12px 0', caretColor: '#d4d7dd' },
  '.cm-gutters': {
    backgroundColor: '#15181e',
    borderRight: '1px solid #242933',
    color: '#5f6877',
  },
  '&.cm-focused': { outline: 'none' },
})
