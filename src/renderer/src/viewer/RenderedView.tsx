import { ExternalDocumentWorkspace } from './external-document-context'
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'

import {
  HTML_SANDBOX,
  renderedFileType,
  type CreateHtmlPreviewResponse,
  type HostPath,
} from '../../../shared'
import { renderMarkdown, resetMarkdownRenderer } from './markdown-client'
import {
  assertRenderedMarkup,
  admitRenderedDiagram,
  assertRenderedDiagramIndex,
} from './rendered-workload-policy'
import { renderMermaid } from './mermaid-client'
import { DomFindTarget } from './dom-find-target'
import { handleRenderedLinkClick } from './rendered-link-handler'
import type {
  JsonNodeDescriptor,
  JsonWorkerRequestInput,
  JsonWorkerResponse,
} from './json-protocol'
import { useAppTheme } from '../theme'
import type { CsvTableData } from './csv-parser'
import type { CsvWorkerResponse } from './csv-protocol'
import type { ViewerDocumentPosition, ViewerDocumentRefresh } from './tab-state'
import type { RegisterViewerFindTarget } from './viewer-find'
import { captureRenderedPosition, restoreRenderedPosition } from './rendered-position'
import { documentLineCount, type ViewerPositionCapture } from './viewer-position'
import { RepositoryImageView } from './RepositoryImageView'
import { MarkdownRepositoryImages } from './markdown-repository-images'
import { bindRenderedDocumentReview } from '../document-review/document-review-rendered'
import { useDocumentReviewInlineHostRegistration } from '../document-review/document-review-inline'
import type { DocumentReviewDocumentProjection } from '../document-review/use-document-review-interaction'

let jsonWorker: Worker | undefined
let jsonRequestId = 0
let jsonDocumentId = 0
let csvWorker: Worker | undefined
let csvRequestId = 0

function getJsonWorker(): Worker {
  jsonWorker ??= new Worker(new URL('./json.worker.ts', import.meta.url), {
    type: 'module',
  })
  return jsonWorker
}

function getCsvWorker(): Worker {
  csvWorker ??= new Worker(new URL('./csv.worker.ts', import.meta.url), {
    type: 'module',
  })
  return csvWorker
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    jsonWorker?.terminate()
    jsonWorker = undefined
    csvWorker?.terminate()
    csvWorker = undefined
  })
}

interface RenderedViewProps {
  readonly path: HostPath
  readonly content: string
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly onOpenPath: (path: HostPath) => void
  readonly refresh?: ViewerDocumentRefresh
  readonly onDependencies: (paths: readonly HostPath[]) => void
  readonly registerFindTarget: RegisterViewerFindTarget
  readonly documentReview?: DocumentReviewDocumentProjection
}

export function RenderedView({
  path,
  content,
  position,
  onPosition,
  positionCapture,
  onOpenPath,
  refresh,
  onDependencies,
  registerFindTarget,
  documentReview,
}: RenderedViewProps): ReactElement {
  const renderGeneration = useDevRendererGeneration()
  const theme = useAppTheme()
  const type = renderedFileType(path)
  if (type === 'image') {
    return <RepositoryImageView path={path} refreshVersion={refresh?.version ?? 0} />
  }
  if (type === 'csv') {
    return (
      <CsvView
        content={content}
        position={position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        renderGeneration={renderGeneration}
        registerFindTarget={registerFindTarget}
      />
    )
  }
  if (type === 'html') {
    return (
      <HtmlPreview path={path} content={content} renderGeneration={renderGeneration} />
    )
  }
  if (type === 'json' || type === 'jsonl' || type === 'yaml') {
    return (
      <StructuredDataView
        content={content}
        format={type}
        renderGeneration={renderGeneration}
        position={position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        registerFindTarget={registerFindTarget}
      />
    )
  }
  if (type === 'mermaid') {
    return (
      <StandaloneMermaid
        content={content}
        renderGeneration={renderGeneration}
        theme={theme}
        registerFindTarget={registerFindTarget}
      />
    )
  }
  if (type === 'markdown') {
    return (
      <MarkdownView
        path={path}
        content={content}
        position={position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        onOpenPath={onOpenPath}
        renderGeneration={renderGeneration}
        refresh={refresh}
        onDependencies={onDependencies}
        theme={theme}
        registerFindTarget={registerFindTarget}
        documentReview={documentReview}
      />
    )
  }
  return (
    <div className="viewer-empty hvir-state">No rendered view for this file type</div>
  )
}

function CsvView({
  content,
  position,
  onPosition,
  positionCapture,
  renderGeneration,
  registerFindTarget,
}: {
  readonly content: string
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly renderGeneration: number
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const [table, setTable] = useState<CsvTableData>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setTable(undefined)
    setError(undefined)
    void requestCsv(content).then(
      (parsed) => {
        if (!cancelled) setTable(parsed)
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [content, renderGeneration])

  useRenderedPosition(container, content, position, onPosition, positionCapture, table)
  useRenderedFindTarget(container, table, registerFindTarget)

  if (error)
    return <div className="viewer-empty error hvir-state">Invalid CSV: {error}</div>
  if (!table) return <div className="viewer-empty hvir-state">Parsing CSV…</div>
  const [headings = [], ...rows] = table.rows
  const visibleColumns = table.rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  )
  const columnIndexes = Array.from({ length: visibleColumns }, (_, index) => index)
  const notes = [
    table.truncated
      ? `Showing ${table.rows.length.toLocaleString()} of ${table.totalRows.toLocaleString()} rows; use Source for complete data`
      : undefined,
    table.contentTruncated
      ? 'Cell text omitted to keep the preview responsive; use Source for complete data'
      : undefined,
    table.columnsTruncated
      ? `first ${visibleColumns.toLocaleString()} of ${table.totalColumns.toLocaleString()} columns`
      : undefined,
  ].filter((note): note is string => Boolean(note))
  return (
    <div className="rendered-scroll csv-view hvir-scroll" ref={container}>
      {notes.length > 0 ? <div className="csv-note">{notes.join(' · ')}</div> : null}
      <table>
        <thead>
          <tr data-source-line="1">
            {columnIndexes.map((index) => {
              const heading = headings[index] ?? ''
              return (
                <th key={index} title={heading}>
                  {heading || `Column ${index + 1}`}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} data-source-line={rowIndex + 2}>
              {columnIndexes.map((columnIndex) => (
                <td key={columnIndex} title={row[columnIndex] ?? ''}>
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HtmlPreview({
  path,
  content,
  renderGeneration,
}: {
  readonly path: HostPath
  readonly content: string
  readonly renderGeneration: number
}): ReactElement {
  const workspaceRoot = useContext(ExternalDocumentWorkspace)
  const [preview, setPreview] = useState<CreateHtmlPreviewResponse>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let previewId: string | undefined
    setPreview(undefined)
    setError(undefined)
    void window.hvir.invoke('html-preview:create', { path, content, workspaceRoot }).then(
      (created) => {
        previewId = created.id
        if (cancelled) {
          window.hvir.send('html-preview:release', { id: created.id })
        } else {
          setPreview(created)
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
      if (previewId) window.hvir.send('html-preview:release', { id: previewId })
    }
  }, [content, path, renderGeneration, workspaceRoot])

  if (error) return <div className="viewer-empty error hvir-state">{error}</div>
  if (!preview)
    return <div className="viewer-empty hvir-state">Preparing HTML preview…</div>
  return (
    <iframe
      className="html-preview"
      title={`Rendered ${path.path}`}
      sandbox={HTML_SANDBOX}
      referrerPolicy="no-referrer"
      src={preview.url}
    />
  )
}

function MarkdownView({
  path,
  content,
  position,
  onPosition,
  positionCapture,
  onOpenPath,
  renderGeneration,
  refresh,
  onDependencies,
  theme,
  registerFindTarget,
  documentReview,
}: RenderedViewProps & {
  readonly renderGeneration: number
  readonly theme: 'dark' | 'light'
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const registerReviewInlineHost = useDocumentReviewInlineHostRegistration()
  const workspaceRoot = useContext(ExternalDocumentWorkspace)
  const repositoryImages = useRef<MarkdownRepositoryImages>(undefined)
  const refreshRef = useRef(refresh)
  const appliedRefreshVersion = useRef(refresh?.version ?? 0)
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string>()
  refreshRef.current = refresh

  useEffect(() => {
    let cancelled = false
    setHtml('')
    setError(undefined)
    void renderMarkdown(content, theme, undefined, true).then(
      (rendered) => {
        if (cancelled) return
        try {
          assertRenderedMarkup(rendered)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
          return
        }
        setHtml(rendered)
        setError(undefined)
      },
      (reason: unknown) => {
        if (cancelled) return
        setHtml('')
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
    }
  }, [content, renderGeneration, theme])

  useEffect(() => {
    const root = container.current
    if (!root || !html) return
    appliedRefreshVersion.current = refreshRef.current?.version ?? 0
    const diagrams = new AbortController()
    const images = new MarkdownRepositoryImages(path, workspaceRoot)
    images.mount(root, html)
    repositoryImages.current = images
    onDependencies(images.hydrate(root))
    void renderMermaidNodes(root, diagrams.signal, theme)
    return () => {
      diagrams.abort()
      onDependencies([])
      images.dispose()
      if (repositoryImages.current === images) repositoryImages.current = undefined
    }
  }, [html, onDependencies, path, theme, workspaceRoot])

  useEffect(() => {
    if (!refresh || refresh.version === appliedRefreshVersion.current) return
    const root = container.current
    if (!root || !html) return
    for (const change of refresh.changes) {
      if (change.version > appliedRefreshVersion.current) {
        repositoryImages.current?.refresh(root, change.path)
      }
    }
    appliedRefreshVersion.current = refresh.version
  }, [html, path, refresh])

  useEffect(() => {
    const root = container.current
    if (!root || !html || !documentReview) return
    return bindRenderedDocumentReview(root, {
      active: documentReview.active,
      dirty: documentReview.dirty,
      comments: documentReview.comments,
      inlineRange: documentReview.inlineRange,
      onInlineHost: registerReviewInlineHost,
      onCapture: documentReview.onCapture,
      onOpenComment: documentReview.onOpenComment,
      onExit: documentReview.onExit,
    })
    // Rebind whenever the image/markup effect above replaces the document nodes,
    // including a new canonical path object from a workspace reload.
  }, [
    documentReview,
    html,
    onDependencies,
    path,
    registerReviewInlineHost,
    theme,
    workspaceRoot,
  ])

  useRenderedPosition(container, content, position, onPosition, positionCapture, html)
  useRenderedFindTarget(container, html || undefined, registerFindTarget)

  if (error) return <div className="viewer-empty error hvir-state">{error}</div>
  if (!html) return <div className="viewer-empty hvir-state">Rendering markdown…</div>
  return (
    <div
      className="rendered-scroll markdown-body hvir-scroll"
      ref={container}
      onClick={(event) => handleRenderedLinkClick(event, path, onOpenPath)}
    />
  )
}

function StandaloneMermaid({
  content,
  renderGeneration,
  theme,
  registerFindTarget,
}: {
  readonly content: string
  readonly renderGeneration: number
  readonly theme: 'dark' | 'light'
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const controller = new AbortController()
    root.textContent = 'Rendering diagram…'
    void renderMermaid(content, theme, controller.signal).then(
      (svg) => {
        if (!controller.signal.aborted) root.innerHTML = svg
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          root.textContent = error instanceof Error ? error.message : String(error)
      },
    )
    return () => {
      controller.abort()
    }
  }, [content, renderGeneration, theme])
  useRenderedFindTarget(
    ref,
    `${content}:${renderGeneration}:${theme}`,
    registerFindTarget,
  )
  return <div className="rendered-scroll mermaid-standalone hvir-scroll" ref={ref} />
}

async function renderMermaidNodes(
  root: HTMLElement,
  signal: AbortSignal,
  theme: 'dark' | 'light',
): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.mermaid-diagram')]
  let budget = { elements: root.querySelectorAll('*').length, characters: 0 }
  for (const [index, node] of nodes.entries()) {
    if (signal.aborted) return
    const source = node.querySelector('pre')?.textContent
    if (source === undefined) continue
    try {
      assertRenderedDiagramIndex(index)
      const svg = await renderMermaid(source, theme, signal)
      if (signal.aborted) return
      budget = admitRenderedDiagram(budget, svg, node.querySelectorAll('*').length)
      node.innerHTML = svg
    } catch (error) {
      if (signal.aborted) return
      node.textContent = error instanceof Error ? error.message : String(error)
      node.classList.add('render-error')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

function StructuredDataView({
  content,
  format,
  renderGeneration,
  position,
  onPosition,
  positionCapture,
  registerFindTarget,
}: {
  readonly content: string
  readonly format: 'json' | 'jsonl' | 'yaml'
  readonly renderGeneration: number
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<{
    readonly id: number
    readonly root: JsonNodeDescriptor
  }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const documentId = ++jsonDocumentId
    let cancelled = false
    setDocument(undefined)
    setError(undefined)
    void requestJson({ type: 'parse', documentId, source: content, format }).then(
      (response) => {
        if (!cancelled && response.type === 'parsed') {
          setDocument({ id: documentId, root: response.root })
        }
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      cancelled = true
      void requestJson({ type: 'dispose', documentId }).catch(() => undefined)
    }
  }, [content, format, renderGeneration])

  useRenderedPosition(
    container,
    format === 'jsonl' ? '' : content,
    position,
    onPosition,
    positionCapture,
    document,
  )
  useRenderedFindTarget(container, document, registerFindTarget)

  if (error)
    return (
      <div className="viewer-empty error hvir-state">
        Invalid {format.toUpperCase()}: {error}
      </div>
    )
  if (!document)
    return <div className="viewer-empty hvir-state">Parsing {format.toUpperCase()}…</div>
  if (format === 'jsonl')
    return (
      <JsonRecords
        key={document.id}
        documentId={document.id}
        total={document.root.count ?? 0}
        content={content}
        position={position}
        onPosition={onPosition}
        positionCapture={positionCapture}
        registerFindTarget={registerFindTarget}
      />
    )
  return (
    <div className="rendered-scroll json-tree hvir-scroll" ref={container}>
      <JsonNode node={document.root} documentId={document.id} initiallyOpen />
    </div>
  )
}

/** Replace pages rather than accumulating record nodes for a large log. */
function JsonRecords({
  documentId,
  total,
  content,
  position,
  onPosition,
  positionCapture,
  registerFindTarget,
}: {
  readonly documentId: number
  readonly total: number
  readonly content: string
  readonly position: ViewerDocumentPosition
  readonly onPosition: (position: ViewerDocumentPosition) => void
  readonly positionCapture: ViewerPositionCapture
  readonly registerFindTarget: RegisterViewerFindTarget
}): ReactElement {
  const pageSize = 100
  const container = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(() =>
    Math.min(
      Math.floor(Math.max(0, position.line - 1) / pageSize) * pageSize,
      Math.max(0, Math.floor((total - 1) / pageSize) * pageSize),
    ),
  )
  const [records, setRecords] = useState<readonly JsonNodeDescriptor[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setRecords(undefined)
    setError(undefined)
    void requestJson({
      type: 'children',
      documentId,
      path: [],
      offset,
      limit: pageSize,
    }).then(
      (response) => {
        if (!cancelled && response.type === 'children') setRecords(response.children)
      },
      () => {
        if (!cancelled) setError('Unable to load records')
      },
    )
    return () => {
      cancelled = true
    }
  }, [documentId, offset])
  useRenderedPosition(container, content, position, onPosition, positionCapture, records)
  useRenderedFindTarget(container, records, registerFindTarget)
  const changePage = (nextOffset: number): void => {
    setOffset(nextOffset)
    onPosition({ mode: 'rendered', line: nextOffset + 1, scrollTop: 0 })
  }
  return (
    <div className="rendered-scroll json-tree jsonl-tree hvir-scroll" ref={container}>
      <nav
        className="jsonl-pages"
        aria-label="JSONL records"
        data-source-line={offset + 1}
      >
        <button
          type="button"
          className="json-more hvir-button"
          disabled={offset === 0}
          onClick={() => changePage(offset - pageSize)}
        >
          Previous records
        </button>
        <span>
          {total === 0
            ? 'No records'
            : `Records ${offset + 1}–${Math.min(total, offset + pageSize)} of ${total}`}
        </span>
        <button
          type="button"
          className="json-more hvir-button"
          disabled={offset + pageSize >= total}
          onClick={() => changePage(offset + pageSize)}
        >
          Next records
        </button>
      </nav>
      {!records && !error ? <div role="status">Loading records…</div> : null}
      {error ? (
        <div className="json-error" role="alert">
          {error}
        </div>
      ) : null}
      {records?.map((node) => (
        <section
          className="jsonl-record"
          key={node.sourceLine}
          data-source-line={node.sourceLine}
        >
          {node.error ? (
            <div className="json-error">
              Line {node.sourceLine}: {node.error}
            </div>
          ) : (
            <JsonNode node={node} documentId={documentId} />
          )}
        </section>
      ))}
    </div>
  )
}

function useRenderedPosition(
  container: RefObject<HTMLElement | null>,
  content: string,
  position: ViewerDocumentPosition,
  onPosition: (position: ViewerDocumentPosition) => void,
  positionCapture: ViewerPositionCapture,
  readyKey: unknown,
): void {
  const positionRef = useRef(position)
  const onPositionRef = useRef(onPosition)
  const lines = useMemo(() => documentLineCount(content), [content])
  positionRef.current = position
  onPositionRef.current = onPosition

  useEffect(() => {
    const root = container.current
    if (!root || readyKey === undefined) return
    const capture = (): ViewerDocumentPosition => captureRenderedPosition(root, lines)
    const handleScroll = (): void => onPositionRef.current(capture())
    positionCapture.current = capture
    root.addEventListener('scroll', handleScroll, { passive: true })
    restoreRenderedPosition(root, positionRef.current, lines)
    return () => {
      root.removeEventListener('scroll', handleScroll)
      if (positionCapture.current === capture) positionCapture.current = undefined
    }
  }, [container, lines, positionCapture, readyKey])
}

function useRenderedFindTarget(
  container: RefObject<HTMLElement | null>,
  readyKey: unknown,
  registerFindTarget: RegisterViewerFindTarget,
): void {
  useEffect(() => {
    const root = container.current
    if (!root || readyKey === undefined) return
    const target = new DomFindTarget(root)
    const unregister = registerFindTarget(target)
    return () => {
      unregister()
      target.dispose()
    }
  }, [container, readyKey, registerFindTarget])
}

/** Re-render active previews when their implementation changes during Vite dev HMR. */
function useDevRendererGeneration(): number {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const hot = import.meta.hot
    if (!hot) return
    const refresh = (): void => {
      resetMarkdownRenderer()
      jsonWorker?.terminate()
      jsonWorker = undefined
      setGeneration((current) => current + 1)
    }
    hot.on('vite:afterUpdate', refresh)
    return () => hot.off?.('vite:afterUpdate', refresh)
  }, [])
  return generation
}

function JsonNode({
  node,
  documentId,
  initiallyOpen = false,
}: {
  readonly node: JsonNodeDescriptor
  readonly documentId: number
  readonly initiallyOpen?: boolean
}): ReactElement {
  const collection = node.kind === 'array' || node.kind === 'object'
  const [open, setOpen] = useState(initiallyOpen)
  const [children, setChildren] = useState<readonly JsonNodeDescriptor[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const total = node.count ?? 0

  const loadMore = (): void => {
    if (loading || children.length >= total) return
    setLoading(true)
    void requestJson({
      type: 'children',
      documentId,
      path: node.path,
      offset: children.length,
      limit: 200,
    })
      .then(
        (response) => {
          if (response.type === 'children') {
            setChildren((current) => [...current, ...response.children])
            setError(undefined)
          }
        },
        (reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (open && collection && total > 0 && children.length === 0 && !loading) {
      loadMore()
    }
  })

  if (!collection) {
    return (
      <div className="json-leaf">
        <span className="json-key">{node.label}:</span> <JsonScalar node={node} />
      </div>
    )
  }
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="json-key">{node.label}</span>
        <span className="json-count">
          {' '}
          {node.kind === 'array' ? `[${total}]` : `{${total}}`}
        </span>
      </summary>
      {open ? (
        <div className="json-children">
          {children.map((child) => (
            <JsonNode
              key={`${child.path.length}:${child.path.at(-1)}`}
              node={child}
              documentId={documentId}
            />
          ))}
          {error ? <div className="json-error">{error}</div> : null}
          {children.length < total ? (
            <button className="json-more hvir-button" type="button" onClick={loadMore}>
              {loading ? 'Loading…' : `Show more (${children.length}/${total})`}
            </button>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

function JsonScalar({ node }: { readonly node: JsonNodeDescriptor }): ReactElement {
  const text = node.kind === 'string' ? JSON.stringify(node.value) : String(node.value)
  return (
    <span className={`json-${node.kind}`}>
      {text}
      {node.truncated ? '… (value preview; full value in source)' : null}
    </span>
  )
}

function requestJson(input: JsonWorkerRequestInput): Promise<JsonWorkerResponse> {
  const worker = getJsonWorker()
  const requestId = ++jsonRequestId
  return new Promise<JsonWorkerResponse>((resolve, reject) => {
    const onMessage = (event: MessageEvent<JsonWorkerResponse>): void => {
      if (event.data.requestId !== requestId) return
      cleanup()
      if (event.data.type === 'error') reject(new Error(event.data.message))
      else resolve(event.data)
    }
    const onError = (event: ErrorEvent): void => {
      cleanup()
      reject(new Error(event.message))
    }
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ ...input, requestId })
  })
}

function requestCsv(source: string): Promise<CsvTableData> {
  const worker = getCsvWorker()
  const id = ++csvRequestId
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<CsvWorkerResponse>): void => {
      if (event.data.id !== id) return
      cleanup()
      if (event.data.ok) resolve(event.data.table)
      else reject(new Error(event.data.error))
    }
    const onError = (event: ErrorEvent): void => {
      cleanup()
      reject(new Error(event.message || 'CSV worker unavailable'))
    }
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ id, source })
  })
}
