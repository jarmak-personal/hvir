import { randomUUID } from 'node:crypto'
import { protocol } from 'electron'

import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SCHEME,
  type CreateHtmlPreviewResponse,
} from '../shared'

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
const MAX_LIVE_DOCUMENTS = 64

/**
 * Serves untrusted HTML from a dedicated origin with a response-header CSP.
 * The iframe still omits allow-same-origin, so each document receives an
 * opaque origin even though the scheme itself is registered as standard.
 */
export class HtmlPreviewProtocol {
  private readonly documents = new Map<string, string>()
  private registered = false

  register(): void {
    if (this.registered) return
    protocol.handle(HTML_PREVIEW_SCHEME, (request) => this.handle(request))
    this.registered = true
  }

  create(content: string): CreateHtmlPreviewResponse {
    if (typeof content !== 'string') throw new Error('HTML preview content must be text')
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new Error('HTML previews are limited to 64 MiB')
    }
    while (this.documents.size >= MAX_LIVE_DOCUMENTS) {
      const oldest = this.documents.keys().next().value
      if (!oldest) break
      this.documents.delete(oldest)
    }
    const id = randomUUID()
    this.documents.set(id, content)
    return { id, url: `${HTML_PREVIEW_SCHEME}://document/${id}/index.html` }
  }

  release(id: string): void {
    if (/^[0-9a-f-]{36}$/i.test(id)) this.documents.delete(id)
  }

  clear(): void {
    this.documents.clear()
  }

  dispose(): void {
    this.clear()
    if (this.registered) protocol.unhandle(HTML_PREVIEW_SCHEME)
    this.registered = false
  }

  private handle(request: Request): Response {
    const url = new URL(request.url)
    const [id, leaf, extra] = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'document' || !id || leaf !== 'index.html' || extra) {
      return response('Not found', 404, 'text/plain; charset=utf-8')
    }
    const content = this.documents.get(id)
    if (content === undefined) {
      return response('Preview expired', 404, 'text/plain; charset=utf-8')
    }
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': HTML_PREVIEW_CSP,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
}

function response(body: string, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
