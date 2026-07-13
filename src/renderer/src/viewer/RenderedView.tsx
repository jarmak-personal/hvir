import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'

import {
  HTML_SANDBOX,
  resolveRenderedLink,
  renderedFileType,
  unwrapOperation,
  type CreateHtmlPreviewResponse,
  type HostPath,
} from '../../../shared'
import type { MarkdownRenderResponse } from './render-protocol'
import type {
  JsonNodeDescriptor,
  JsonWorkerRequestInput,
  JsonWorkerResponse,
} from './json-protocol'

let markdownWorker: Worker | undefined
let jsonWorker: Worker | undefined
let renderRequestId = 0
let jsonRequestId = 0
let jsonDocumentId = 0
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined

function getMarkdownWorker(): Worker {
  markdownWorker ??= new Worker(new URL('./markdown.worker.ts', import.meta.url), {
    type: 'module',
  })
  return markdownWorker
}

function getJsonWorker(): Worker {
  jsonWorker ??= new Worker(new URL('./json.worker.ts', import.meta.url), {
    type: 'module',
  })
  return jsonWorker
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    markdownWorker?.terminate()
    markdownWorker = undefined
    jsonWorker?.terminate()
    jsonWorker = undefined
  })
}

interface RenderedViewProps {
  readonly path: HostPath
  readonly content: string
  readonly scrollTop: number
  readonly onScroll: (scrollTop: number) => void
  readonly onOpenPath: (path: HostPath) => void
  readonly refreshVersion: number
}

export function RenderedView({
  path,
  content,
  scrollTop,
  onScroll,
  onOpenPath,
  refreshVersion,
}: RenderedViewProps): ReactElement {
  const renderGeneration = useDevRendererGeneration()
  const type = renderedFileType(path)
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
        scrollTop={scrollTop}
        onScroll={onScroll}
      />
    )
  }
  if (type === 'mermaid') {
    return <StandaloneMermaid content={content} renderGeneration={renderGeneration} />
  }
  if (type === 'markdown') {
    return (
      <MarkdownView
        path={path}
        content={content}
        scrollTop={scrollTop}
        onScroll={onScroll}
        onOpenPath={onOpenPath}
        renderGeneration={renderGeneration}
        refreshVersion={refreshVersion}
      />
    )
  }
  return <div className="viewer-empty">No rendered view for this file type</div>
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
    void window.hvir.invoke('html-preview:create', { content }).then(
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
  }, [content, renderGeneration])

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
  scrollTop,
  onScroll,
  onOpenPath,
  renderGeneration,
  refreshVersion,
}: RenderedViewProps & { readonly renderGeneration: number }): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(scrollTop)
  const [html, setHtml] = useState('')
  const [error, setError] = useState<string>()
  scrollTopRef.current = scrollTop

  useEffect(() => {
    const worker = getMarkdownWorker()
    const id = ++renderRequestId
    setHtml('')
    setError(undefined)
    const onMessage = (event: MessageEvent<MarkdownRenderResponse>): void => {
      if (event.data.id !== id) return
      if (event.data.ok) {
        setHtml(event.data.html)
        setError(undefined)
      } else {
        setHtml('')
        setError(event.data.error)
      }
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ id, markdown: content })
    return () => worker.removeEventListener('message', onMessage)
  }, [content, renderGeneration])

  useEffect(() => {
    const root = container.current
    if (!root || !html) return
    root.innerHTML = html
    root.scrollTop = scrollTopRef.current
  }, [html, refreshVersion])

  useEffect(() => {
    const root = container.current
    if (!root || !html) return
    let cancelled = false
    const objectUrls: string[] = []
    for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
      void hydrateRepositoryImage(path, image, () => cancelled).then((objectUrl) => {
        if (!objectUrl) return
        if (cancelled) URL.revokeObjectURL(objectUrl)
        else objectUrls.push(objectUrl)
      })
    }
    void renderMermaidNodes(root, () => cancelled)
    return () => {
      cancelled = true
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
    }
  }, [html, path, refreshVersion])

  if (error) return <div className="viewer-empty error">{error}</div>
  if (!html) return <div className="viewer-empty">Rendering markdown…</div>
  const followLink = (event: MouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || !event.currentTarget.contains(anchor)) return
    const href = anchor.getAttribute('href')
    if (!href) return
    const target = resolveRenderedLink(path, href)
    event.preventDefault()
    if (target.kind === 'file') {
      onOpenPath(target.path)
    } else if (target.kind === 'external') {
      window.open(target.url, '_blank', 'noopener,noreferrer')
    } else if (target.kind === 'anchor') {
      const destination = [
        ...event.currentTarget.querySelectorAll<HTMLElement>('[id]'),
      ].find((element) => element.id === target.fragment)
      destination?.scrollIntoView({ block: 'start' })
    }
  }
  return (
    <div
      className="rendered-scroll markdown-body"
      ref={container}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      onClick={followLink}
    />
  )
}

async function hydrateRepositoryImage(
  documentPath: HostPath,
  image: HTMLImageElement,
  cancelled: () => boolean,
): Promise<string | undefined> {
  const source = image.getAttribute('src')
  if (!source) return undefined
  const target = resolveRenderedLink(documentPath, source)
  if (target.kind !== 'file') return undefined
  image.removeAttribute('src')
  image.classList.add('markdown-image-loading')
  try {
    const asset = unwrapOperation(
      await window.hvir.invoke('fs:read-asset', { path: target.path }),
    )
    if (cancelled()) return undefined
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }),
    )
    image.src = objectUrl
    image.classList.remove('markdown-image-loading')
    return objectUrl
  } catch (reason) {
    if (cancelled()) return undefined
    const unavailable = document.createElement('span')
    unavailable.className = 'markdown-image-unavailable'
    unavailable.textContent = image.alt
      ? `[Image unavailable: ${image.alt}]`
      : '[Repository image unavailable]'
    unavailable.title = reason instanceof Error ? reason.message : String(reason)
    image.replaceWith(unavailable)
    return undefined
  }
}

function StandaloneMermaid({
  content,
  renderGeneration,
}: {
  readonly content: string
  readonly renderGeneration: number
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let cancelled = false
    root.textContent = 'Rendering diagram…'
    void renderMermaid(content, `mermaid-${++renderRequestId}`).then(
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
  }, [content, renderGeneration])
  return <div className="rendered-scroll mermaid-standalone" ref={ref} />
}

async function renderMermaidNodes(
  root: HTMLElement,
  cancelled: () => boolean,
): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.mermaid-diagram')]
  for (const node of nodes) {
    if (cancelled()) return
    const source = node.querySelector('pre')?.textContent
    if (source === undefined) continue
    try {
      node.innerHTML = await renderMermaid(source, `mermaid-${++renderRequestId}`)
    } catch (error) {
      node.textContent = error instanceof Error ? error.message : String(error)
      node.classList.add('render-error')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function renderMermaid(source: string, id: string): Promise<string> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      suppressErrorRendering: true,
    })
    return mermaid
  })
  const mermaid = await mermaidPromise
  const { svg } = await mermaid.render(id, source)
  return svg
}

function StructuredDataView({
  content,
  format,
  renderGeneration,
  scrollTop,
  onScroll,
}: {
  readonly content: string
  readonly format: 'json' | 'yaml'
  readonly renderGeneration: number
  readonly scrollTop: number
  readonly onScroll: (scrollTop: number) => void
}): ReactElement {
  const container = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(scrollTop)
  const [document, setDocument] = useState<{
    readonly id: number
    readonly root: JsonNodeDescriptor
  }>()
  const [error, setError] = useState<string>()
  scrollTopRef.current = scrollTop

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

  useEffect(() => {
    if (document && container.current) {
      container.current.scrollTop = scrollTopRef.current
    }
  }, [document])

  if (error)
    return (
      <div className="viewer-empty error">
        Invalid {format.toUpperCase()}: {error}
      </div>
    )
  if (!document)
    return <div className="viewer-empty">Parsing {format.toUpperCase()}…</div>
  return (
    <div
      className="rendered-scroll json-tree"
      ref={container}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <JsonNode node={document.root} documentId={document.id} initiallyOpen />
    </div>
  )
}

/** Re-render active previews when their implementation changes during Vite dev HMR. */
function useDevRendererGeneration(): number {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const hot = import.meta.hot
    if (!hot) return
    const refresh = (): void => {
      markdownWorker?.terminate()
      markdownWorker = undefined
      jsonWorker?.terminate()
      jsonWorker = undefined
      mermaidPromise = undefined
      setGeneration((current) => current + 1)
    }
    hot.on('vite:afterUpdate', refresh)
    return () => hot.off('vite:afterUpdate', refresh)
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
