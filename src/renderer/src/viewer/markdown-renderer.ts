import MarkdownIt, { type Token } from 'markdown-it'

import { MARKDOWN_OPTIONS } from './render-protocol'
import {
  enableSourceLineAnchors,
  enableTaskLists,
  wrapSourceLine,
} from './markdown-extensions'
import type { LoadedViewerGrammar, ViewerGrammarRegistry } from './shiki-grammar-registry'

const MERMAID_FENCE_LANGUAGES = new Set(['mermaid', 'mmd'])
const PLAIN_FENCE_LANGUAGES = new Set(['plain', 'plaintext', 'text', 'txt'])

export async function renderMarkdownDocument(
  source: string,
  theme: 'dark' | 'light',
  grammars: Pick<ViewerGrammarRegistry, 'load'>,
): Promise<string> {
  // Bare repository filenames such as `design.md` are not web hosts. The
  // linkifier turns them into http://design.md and can navigate Electron's
  // main frame; authored Markdown links still render normally.
  const markdown = enableSourceLineAnchors(
    enableTaskLists(new MarkdownIt(MARKDOWN_OPTIONS)),
  )
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
  grammars: Pick<ViewerGrammarRegistry, 'load'>,
): Promise<Map<string, LoadedViewerGrammar>> {
  const loaded = new Map<string, LoadedViewerGrammar>()
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
