import MarkdownIt, { type Token } from 'markdown-it'

import {
  MARKDOWN_OPTIONS,
  type DocumentGrammarPort,
  type DocumentLoadedGrammar,
} from './contract'
import { enableSourceLineAnchors, enableTaskLists, wrapSourceLine } from './extensions'

const MERMAID_FENCE_LANGUAGES = new Set(['mermaid', 'mmd'])
const PLAIN_FENCE_LANGUAGES = new Set(['plain', 'plaintext', 'text', 'txt'])

export async function renderMarkdownDocument(
  source: string,
  theme: 'dark' | 'light',
  grammars: DocumentGrammarPort,
  resources?: 'inert' | 'selected',
): Promise<string> {
  // Bare repository filenames such as `design.md` are not web hosts. The
  // linkifier turns them into http://design.md and can navigate Electron's
  // main frame; authored Markdown links still render normally.
  const markdown = enableSourceLineAnchors(
    enableTaskLists(new MarkdownIt(MARKDOWN_OPTIONS)),
  )
  const validateLink = markdown.validateLink.bind(markdown)
  markdown.validateLink = (url) => url.startsWith('file://') || validateLink(url)
  if (resources === 'inert')
    markdown.renderer.rules.image = (tokens, index) =>
      `<span class="hvir-meta">${escapeHtml(tokens[index]?.content ?? 'Image omitted')}</span>`
  if (resources === 'selected') {
    markdown.renderer.rules.image = (tokens, index) =>
      `<span data-instruction-image="${escapeHtml(String(tokens[index]?.attrGet('src') ?? ''))}">${escapeHtml(tokens[index]?.content ?? 'Image')}</span>`
    markdown.renderer.rules.link_open = (tokens, index) => {
      const href = String(tokens[index]?.attrGet('href') ?? '')
      return href.startsWith('#')
        ? `<a href="${escapeHtml(href)}">`
        : '<span class="instruction-link">'
    }
    markdown.renderer.rules.link_close = (tokens, index) => {
      for (let at = index - 1; at >= 0; at--)
        if (tokens[at]?.type === 'link_open')
          return String(tokens[at]?.attrGet('href') ?? '').startsWith('#')
            ? '</a>'
            : '</span>'
      return '</span>'
    }
  }
  const env: Record<string, unknown> = {}
  const tokens = markdown.parse(source, env)
  const loaded = await loadFenceGrammars(
    tokens.map((token) => token.info),
    grammars,
  )
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    if (!token) return ''
    const language = fenceLanguage(token.info)
    if (MERMAID_FENCE_LANGUAGES.has(language)) {
      return wrapSourceLine(
        token,
        `<div class="mermaid-diagram"><pre>${escapeHtml(token.content)}</pre></div>`,
      )
    }
    const grammar = loaded.get(language)
    if (!grammar) return plainFence(token)
    try {
      return wrapSourceLine(
        token,
        grammar.highlighter.codeToHtml(token.content, {
          lang: grammar.id,
          theme: theme === 'light' ? 'github-light-default' : 'dark-plus',
        }),
      )
    } catch {
      return plainFence(token)
    }
  }
  return markdown.renderer.render(tokens, markdown.options, env)
}

async function loadFenceGrammars(
  infos: readonly string[],
  grammars: DocumentGrammarPort,
): Promise<Map<string, DocumentLoadedGrammar>> {
  const loaded = new Map<string, DocumentLoadedGrammar>()
  const languages = new Set(infos.map(fenceLanguage).filter(Boolean))
  await Promise.all(
    [...languages].map(async (language) => {
      if (MERMAID_FENCE_LANGUAGES.has(language) || PLAIN_FENCE_LANGUAGES.has(language))
        return
      try {
        const grammar = await grammars.load(language)
        if (grammar) loaded.set(language, grammar)
      } catch {
        // One unavailable grammar must not fail the Markdown surface.
      }
    }),
  )
  return loaded
}

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function plainFence(token: Token): string {
  return wrapSourceLine(token, `<pre><code>${escapeHtml(token.content)}</code></pre>`)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
