import { describe, expect, it, vi } from 'vitest'

import { renderMarkdownDocument } from '../src/renderer/src/viewer/markdown-renderer'
import { createViewerGrammarRegistry } from '../src/renderer/src/viewer/shiki-grammar-registry'

describe('rendered Markdown language handling', () => {
  it('loads a bundled language outside the former fixed catalog', async () => {
    const html = await renderMarkdownDocument(
      '```toml\n[viewer]\nlazy = true\n```',
      'dark',
      createViewerGrammarRegistry(),
    )

    expect(html).toContain('class="shiki dark-plus"')
    expect(html).toContain('<span style="color:')
    expect(html).toContain('[viewer]')
  })

  it.each(['mermaid', 'mmd'])('reserves the %s fence for diagrams', async (language) => {
    const load = vi.fn()
    const html = await renderMarkdownDocument(
      `\`\`\`${language}\nflowchart LR\nA --> B\n\`\`\``,
      'dark',
      { load },
    )

    expect(html).toContain('class="mermaid-diagram"')
    expect(html).not.toContain('class="shiki')
    expect(load).not.toHaveBeenCalled()
  })

  it.each(['text', 'txt', 'plain'])(
    'keeps the %s fence deliberately plain',
    async (language) => {
      const load = vi.fn()
      const html = await renderMarkdownDocument(
        `\`\`\`${language}\nconst value = 1 < 2\n\`\`\``,
        'dark',
        { load },
      )

      expect(html).toContain('<pre><code>')
      expect(html).toContain('1 &lt; 2')
      expect(html).not.toContain('class="shiki')
      expect(load).not.toHaveBeenCalled()
    },
  )

  it('contains unknown and failed grammars to an escaped plain fence', async () => {
    const unknown = await renderMarkdownDocument(
      '```unknown\n<script>alert(1)</script>\n```',
      'dark',
      { load: () => Promise.resolve(undefined) },
    )
    const failed = await renderMarkdownDocument(
      '```toml\n<script>alert(2)</script>\n```',
      'dark',
      { load: () => Promise.reject(new Error('grammar failed')) },
    )

    expect(unknown).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(failed).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(unknown).not.toContain('<script>')
    expect(failed).not.toContain('<script>')
  })
})
