import MarkdownIt from 'markdown-it'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import type { MarkdownRenderRequest, MarkdownRenderResponse } from './render-protocol'

const highlighterPromise = createHighlighterCore({
  themes: [import('@shikijs/themes/dark-plus')],
  langs: [
    import('@shikijs/langs/bash'),
    import('@shikijs/langs/css'),
    import('@shikijs/langs/go'),
    import('@shikijs/langs/html'),
    import('@shikijs/langs/javascript'),
    import('@shikijs/langs/jsx'),
    import('@shikijs/langs/json'),
    import('@shikijs/langs/markdown'),
    import('@shikijs/langs/python'),
    import('@shikijs/langs/rust'),
    import('@shikijs/langs/tsx'),
    import('@shikijs/langs/typescript'),
  ],
  engine: createJavaScriptRegexEngine(),
})

self.onmessage = (event: MessageEvent<MarkdownRenderRequest>): void => {
  void render(event.data)
}

async function render(request: MarkdownRenderRequest): Promise<void> {
  try {
    const highlighter = await highlighterPromise
    const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true })
    markdown.renderer.rules.fence = (tokens, index) => {
      const token = tokens[index]
      if (!token) return ''
      const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      if (language === 'mermaid') {
        return `<div class="mermaid-diagram"><pre>${escapeHtml(token.content)}</pre></div>`
      }
      try {
        return highlighter.codeToHtml(token.content, {
          lang: language || 'text',
          theme: 'dark-plus',
        })
      } catch {
        return `<pre><code>${escapeHtml(token.content)}</code></pre>`
      }
    }
    post({ id: request.id, ok: true, html: markdown.render(request.markdown) })
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function post(message: MarkdownRenderResponse): void {
  self.postMessage(message)
}
