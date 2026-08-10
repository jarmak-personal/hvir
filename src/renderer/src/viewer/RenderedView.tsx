import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'

import {
  HTML_SANDBOX,
  renderedFileType,
  type CreateHtmlPreviewResponse,
  type HostPath,
} from '../../../shared'
import { renderMarkdown, resetMarkdownRenderer } from './markdown-client'
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
let mermaidRequestId = 0
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined
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
  if (type === 'json' || type === 'yaml') {
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
  return <div className="viewer-empty">No rendered view for this file type</div>
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

  if (error) return <div className="viewer-empty error">Invalid CSV: {error}</div>
  if (!table) return <div className="viewer-empty">Parsing CSV…</div>
  const [headings = [], ...rows] = table.rows
  const visibleColumns = table.rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  )
  const columnIndexes = Array.from({ length: visibleColumns }, (_, index) => index)
  const notes = [
    table.truncated
      ? `Showing ${table.rows.length.toLocaleString()} of ${table.totalRows.toLocaleString()} rows`
      : undefined,
    table.columnsTruncated
      ? `first ${visibleColumns.toLocaleString()} of ${table.totalColumns.toLocaleString()} columns`
      : undefined,
  ].filter((note): note is string => Boolean(note))
  return (
    <div className="rendered-scroll csv-view" ref={container}>
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
  const [preview, setPreview] = useState<CreateHtmlPreviewResponse>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let previewId: string | undefined
    setPreview(undefined)
    setError(undefined)
    void window.hvir.invoke('html-preview:create', { path, content }).then(
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
  }, [content, path, renderGeneration])

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!preview) return <div className="viewer-empty">Preparing HTML preview…</div>
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
    void renderMarkdown(content, theme).then(
      (rendered) => {
        if (cancelled) return
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
    root.innerHTML = html
    appliedRefreshVersion.current = refreshRef.current?.version ?? 0
    let cancelled = false
    const images = new MarkdownRepositoryImages(path)
    repositoryImages.current = images
    onDependencies(images.hydrate(root))
    void renderMermaidNodes(root, () => cancelled, theme)
    return () => {
      cancelled = true
      onDependencies([])
      images.dispose()
      if (repositoryImages.current === images) repositoryImages.current = undefined
    }
  }, [html, onDependencies, path, theme])

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
  }, [documentReview, html, registerReviewInlineHost])

  useRenderedPosition(container, content, position, onPosition, positionCapture, html)
  useRenderedFindTarget(container, html || undefined, registerFindTarget)

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!html) return <div className="viewer-empty">Rendering markdown…</div>
  return (
    <div
      className="rendered-scroll markdown-body"
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
    let cancelled = false
    root.textContent = 'Rendering diagram…'
    void renderMermaid(content, `mermaid-${++mermaidRequestId}`, theme).then(
      (svg) => {
        if (!cancelled) root.innerHTML = svg
      },
      (error: unknown) => {
        if (!cancelled)
          root.textContent = error instanceof Error ? error.message : String(error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [content, renderGeneration, theme])
  useRenderedFindTarget(
    ref,
    `${content}:${renderGeneration}:${theme}`,
    registerFindTarget,
  )
  return <div className="rendered-scroll mermaid-standalone" ref={ref} />
}

async function renderMermaidNodes(
  root: HTMLElement,
  cancelled: () => boolean,
  theme: 'dark' | 'light',
): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.mermaid-diagram')]
  for (const node of nodes) {
    if (cancelled()) return
    const source = node.querySelector('pre')?.textContent
    if (source === undefined) continue
    try {
      node.innerHTML = await renderMermaid(source, `mermaid-${++mermaidRequestId}`, theme)
    } catch (error) {
      node.textContent = error instanceof Error ? error.message : String(error)
      node.classList.add('render-error')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function renderMermaid(
  source: string,
  id: string,
  theme: 'dark' | 'light',
): Promise<string> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid)
  const mermaid = await mermaidPromise
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'light' ? 'default' : 'dark',
    suppressErrorRendering: true,
  })
  const { svg } = await mermaid.render(id, source)
  return svg
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
  readonly format: 'json' | 'yaml'
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

  useRenderedPosition(container, content, position, onPosition, positionCapture, document)
  useRenderedFindTarget(container, document, registerFindTarget)

  if (error)
    return (
      <div className="viewer-empty error">
        Invalid {format.toUpperCase()}: {error}
      </div>
    )
  if (!document)
    return <div className="viewer-empty">Parsing {format.toUpperCase()}…</div>
  return (
    <div className="rendered-scroll json-tree" ref={container}>
      <JsonNode node={document.root} documentId={document.id} initiallyOpen />
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
  const lines = documentLineCount(content)
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
      mermaidPromise = undefined
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
              key={`${child.path.length}:${child.label}`}
              node={child}
              documentId={documentId}
            />
          ))}
          {error ? <div className="json-error">{error}</div> : null}
          {children.length < total ? (
            <button className="json-more" type="button" onClick={loadMore}>
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
  return <span className={`json-${node.kind}`}>{text}</span>
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
