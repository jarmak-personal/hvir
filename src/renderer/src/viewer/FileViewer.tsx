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
  renderedFileType,
  type DiffBase,
  type ViewMode,
  type GitBlameRun,
  type HostPath,
} from '../../../shared'
import { DiffView } from './DiffView'
import { captureTopLine, restoreTopLine } from './code-scroll-anchor'
import {
  languageForPath,
  type HighlightResponse,
  type HighlightToken,
} from './highlight-protocol'
import { RenderedView } from './RenderedView'
import type { ViewerDocumentPosition, ViewerTab } from './tab-state'
import {
  approximateLineAtScroll,
  approximateScrollForLine,
  documentLineCount,
  type ViewerPositionCapture,
} from './viewer-position'
import { useAppTheme } from '../theme'

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
  readonly onMode: (mode: ViewMode, position?: ViewerDocumentPosition) => void
  readonly onDiffBase: (base: DiffBase) => void
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onReload: () => void
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly onNavigationHandled: (serial: number) => void
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
  onPosition,
  onNavigationHandled,
  onOpenPath,
  refreshVersion,
}: FileViewerProps): ReactElement {
  const [showBlame, setShowBlame] = useState(false)
  const [blame, setBlame] = useState<readonly GitBlameRun[]>([])
  const [blameStatus, setBlameStatus] = useState('')
  const [modeControlExpanded, setModeControlExpanded] = useState(false)
  const modeControlRef = useRef<HTMLDivElement>(null)
  const currentPath = tab?.path
  const blameMode = tab?.mode
  const positionCapture = useRef<(() => ViewerDocumentPosition) | undefined>(undefined)
  const binaryImage = Boolean(tab?.file?.binary && renderedFileType(tab.path) === 'image')

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

  useEffect(() => {
    if (!modeControlExpanded) return
    const collapseOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !modeControlRef.current?.contains(event.target)
      ) {
        setModeControlExpanded(false)
      }
    }
    document.addEventListener('pointerdown', collapseOutside, true)
    return () => document.removeEventListener('pointerdown', collapseOutside, true)
  }, [modeControlExpanded])

  return (
    <div className="viewer-body">
      {tab ? (
        <div className="viewer-floating-controls" role="toolbar" aria-label="Viewer">
          {tab.conflict ? (
            <button className="conflict-badge" type="button" onClick={onReload}>
              Changed on disk · reload
            </button>
          ) : null}
          {tab.error && tab.file ? (
            <span className="viewer-operation-error" role="status" title={tab.error}>
              Save failed
            </span>
          ) : null}
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
            <div
              ref={modeControlRef}
              className={`mode-control${modeControlExpanded ? ' expanded' : ''}`}
              role="group"
              aria-label="View mode"
              onFocus={(event) => {
                if (
                  event.target instanceof HTMLElement &&
                  event.target.matches(':focus-visible')
                ) {
                  setModeControlExpanded(true)
                }
              }}
              onBlur={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setModeControlExpanded(false)
                }
              }}
            >
              {(['rendered', 'source', 'diff'] as const).map((mode) => (
                <button
                  type="button"
                  className={tab.mode === mode ? 'active' : ''}
                  aria-pressed={tab.mode === mode}
                  aria-expanded={tab.mode === mode ? modeControlExpanded : undefined}
                  title={
                    tab.file?.binary && mode !== 'rendered'
                      ? 'Binary repository assets are available in rendered view only'
                      : mode === 'rendered' && !canRender(tab.path)
                        ? 'No renderer registered for this file type'
                        : tab.mode === mode && !modeControlExpanded
                          ? 'Choose view mode · Ctrl/Cmd+Shift+M cycles modes'
                          : `${mode} view · Ctrl/Cmd+Shift+M cycles modes`
                  }
                  disabled={Boolean(tab.file?.binary && mode !== 'rendered')}
                  key={mode}
                  onClick={() => {
                    if (tab.mode === mode && !modeControlExpanded) {
                      setModeControlExpanded(true)
                      return
                    }
                    setModeControlExpanded(false)
                    onMode(mode, positionCapture.current?.())
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
            <select
              className="mode-select"
              aria-label="View mode"
              value={tab.mode}
              onChange={(event) => {
                onMode(event.currentTarget.value as ViewMode, positionCapture.current?.())
              }}
            >
              {(['rendered', 'source', 'diff'] as const).map((mode) => (
                <option
                  value={mode}
                  disabled={Boolean(tab.file?.binary && mode !== 'rendered')}
                  key={mode}
                >
                  {mode[0]?.toUpperCase()}
                  {mode.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      {!tab ? <EmptyViewer text="Choose a file from the tree" /> : null}
      {tab?.loading ? <EmptyViewer text="Opening…" /> : null}
      {tab?.error && !tab.file ? <EmptyViewer text={tab.error} error /> : null}
      {tab && !tab.loading && tab.file?.binary && !binaryImage ? (
        <BinaryFileView path={tab.path} size={tab.file.size} />
      ) : null}
      {tab && !tab.loading && tab.file && (!tab.file.binary || binaryImage) ? (
        <ActiveView
          tab={tab}
          file={tab.file}
          onContent={onContent}
          onSave={onSave}
          onPosition={onPosition}
          blame={showBlame ? blame : []}
          blameStatus={showBlame ? blameStatus : ''}
          onOpenPath={onOpenPath}
          refreshVersion={refreshVersion}
          positionCapture={positionCapture}
          onNavigationHandled={onNavigationHandled}
        />
      ) : null}
    </div>
  )
}

function BinaryFileView({
  path,
  size,
}: {
  readonly path: HostPath
  readonly size: number
}): ReactElement {
  const extension = basenameHostPath(path).split('.').at(-1)?.toUpperCase()
  return (
    <div className="viewer-empty binary-file-summary">
      <strong>{extension ? `${extension} binary file` : 'Binary file'}</strong>
      <span>{formatBytes(size)}</span>
      <span>Source and diff views are unavailable.</span>
    </div>
  )
}

function ActiveView({
  tab,
  file,
  onContent,
  onSave,
  onPosition,
  blame,
  blameStatus,
  onOpenPath,
  refreshVersion,
  positionCapture,
  onNavigationHandled,
}: {
  readonly tab: ViewerTab
  readonly file: NonNullable<ViewerTab['file']>
  readonly onContent: (content: string) => void
  readonly onSave: () => void
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly blame: readonly GitBlameRun[]
  readonly blameStatus: string
  readonly onOpenPath: (path: HostPath) => void
  readonly refreshVersion: number
  readonly positionCapture: ViewerPositionCapture
  readonly onNavigationHandled: (serial: number) => void
}): ReactElement {
  if (tab.mode === 'rendered') {
    return (
      <RenderedView
        path={tab.path}
        content={file.content}
        position={tab.position}
        onPosition={onPosition}
        positionCapture={positionCapture}
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
        mode={tab.mode}
        position={tab.position}
        onPosition={onPosition}
        positionCapture={positionCapture}
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
        position={tab.position}
        onPosition={onPosition}
        positionCapture={positionCapture}
      />
    )
  }
  return (
    <SourceView
      pathKey={`${tab.path.hostId}:${tab.path.path}`}
      content={file.content}
      size={file.size}
      position={tab.position}
      onContent={onContent}
      onSave={onSave}
      onPosition={onPosition}
      blame={blame}
      blameStatus={blameStatus}
      positionCapture={positionCapture}
      navigation={tab.navigation}
      onNavigationHandled={onNavigationHandled}
    />
  )
}

function LargeFileView({
  content,
  size,
  mode,
  position,
  onPosition,
  positionCapture,
}: {
  readonly content: string
  readonly size: number
  readonly mode: ViewMode
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
}): ReactElement {
  const container = useRef<HTMLPreElement>(null)
  const positionRef = useRef(position)
  const onPositionRef = useRef(onPosition)
  const preview = content.slice(0, LARGE_FILE_PREVIEW_LIMIT)
  const lines = documentLineCount(preview)
  positionRef.current = position
  onPositionRef.current = onPosition
  useEffect(() => {
    const root = container.current
    if (!root) return
    const capture = (): ViewerDocumentPosition => ({
      mode,
      line: approximateLineAtScroll(
        root.scrollTop,
        root.scrollHeight,
        root.clientHeight,
        lines,
      ),
      scrollTop: root.scrollTop,
    })
    const handleScroll = (): void => onPositionRef.current(capture())
    positionCapture.current = capture
    root.addEventListener('scroll', handleScroll, { passive: true })
    const restoreFrame = requestAnimationFrame(() => {
      const restorePosition = positionRef.current
      root.scrollTop =
        restorePosition.mode === mode
          ? restorePosition.scrollTop
          : approximateScrollForLine(
              restorePosition.line,
              root.scrollHeight,
              root.clientHeight,
              lines,
            )
    })
    return () => {
      cancelAnimationFrame(restoreFrame)
      root.removeEventListener('scroll', handleScroll)
      if (positionCapture.current === capture) positionCapture.current = undefined
    }
  }, [lines, mode, positionCapture])
  return (
    <div className="large-file-shell">
      <div className="source-meta">
        <span>{formatBytes(size)}</span>
        <span>read-only preview · first {formatBytes(preview.length)}</span>
      </div>
      <pre ref={container} className="large-file-preview">
        {preview}
      </pre>
    </div>
  )
}

function SourceView({
  pathKey,
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
}: {
  readonly pathKey: string
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
}): ReactElement {
  const theme = useAppTheme()
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const applyingExternal = useRef(false)
  const lastUserContent = useRef<string | undefined>(undefined)
  const callbacks = useRef({ onContent, onSave, onPosition })
  const [highlightStatus, setHighlightStatus] = useState('')
  const blameCompartment = useRef(new Compartment())
  callbacks.current = { onContent, onSave, onPosition }

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
    requestAnimationFrame(() => {
      if (restorePosition.mode === 'source') {
        editor.scrollDOM.scrollTop = restorePosition.scrollTop
      } else restoreTopLine(editor, editor.scrollDOM, restorePosition.line)
    })
    return () => {
      editor.scrollDOM.removeEventListener('scroll', captureScroll)
      if (positionCapture.current === capturePosition) {
        positionCapture.current = undefined
      }
      view.current = undefined
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
      const line = editor.state.doc.line(
        Math.min(editor.state.doc.lines, Math.max(1, Math.floor(navigation.line))),
      )
      const columnOffset = Math.max(0, Math.floor((navigation.column ?? 1) - 1))
      const position = Math.min(line.to, line.from + columnOffset)
      editor.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'center' }),
      })
      onNavigationHandled(navigation.serial)
    })
    return () => cancelAnimationFrame(frame)
  }, [navigation, onNavigationHandled])

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
    return highlight(editor, pathKey, content, size, theme, setHighlightStatus)
  }, [content, pathKey, size, theme])

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
  theme: 'dark' | 'light',
  setStatus: (status: string) => void,
): () => void {
  view.dispatch({ effects: resetTokens.of(null) })
  if (size > HIGHLIGHT_SIZE_LIMIT) {
    setStatus('large file · highlighting off')
    return () => undefined
  }
  const language = languageForPath(path)
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
  worker.postMessage({ id: requestId, code: content, language, theme })
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
  '&': { height: '100%', backgroundColor: 'var(--viewer-bg)', color: 'var(--text)' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    fontSize: '13px',
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
