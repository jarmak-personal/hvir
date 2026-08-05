import type { HighlighterCore } from 'shiki/core'
import { describe, expect, it, vi } from 'vitest'

import {
  createViewerGrammarRegistry,
  ViewerGrammarRegistry,
} from '../src/renderer/src/viewer/shiki-grammar-registry'
import {
  resolveViewerGrammar,
  VIEWER_GRAMMAR_DEFINITIONS,
  type ViewerGrammarDefinition,
} from '../src/renderer/src/viewer/shiki-language-catalog'

describe('viewer Shiki grammar catalog', () => {
  it('normalizes canonical ids and aliases through one definition', () => {
    const canonical = resolveViewerGrammar('docker')
    expect(canonical?.id).toBe('docker')
    expect(resolveViewerGrammar(' DOCKERFILE ')).toBe(canonical)
    expect(resolveViewerGrammar('not-a-shiki-language')).toBeUndefined()
  })

  it('registers one canonical grammar for concurrent canonical and alias requests', async () => {
    const fixture = registryFixture()

    const [canonical, alias] = await Promise.all([
      fixture.registry.load('docker'),
      fixture.registry.load('dockerfile'),
    ])

    expect(canonical?.id).toBe('docker')
    expect(alias?.id).toBe('docker')
    expect(fixture.loadLanguage).toHaveBeenCalledOnce()
    expect(fixture.loadLanguage).toHaveBeenCalledWith(fixture.grammar.load)
  })

  it('does not initialize the highlighter for an unknown language', async () => {
    const fixture = registryFixture()

    await expect(fixture.registry.load('unknown')).resolves.toBeUndefined()

    expect(fixture.loadLanguage).not.toHaveBeenCalled()
  })

  it('drops a failed registration so a later request can retry', async () => {
    const fixture = registryFixture()
    fixture.loadLanguage
      .mockRejectedValueOnce(new Error('grammar unavailable'))
      .mockResolvedValueOnce(undefined)

    await expect(fixture.registry.load('docker')).rejects.toThrow('grammar unavailable')
    await expect(fixture.registry.load('dockerfile')).resolves.toMatchObject({
      id: 'docker',
    })

    expect(fixture.loadLanguage).toHaveBeenCalledTimes(2)
  })

  it('loads and tokenizes every installed grammar with the configured JavaScript engine', async () => {
    expect(VIEWER_GRAMMAR_DEFINITIONS.length).toBeGreaterThan(200)
    const registry = createViewerGrammarRegistry()

    for (const grammar of VIEWER_GRAMMAR_DEFINITIONS) {
      try {
        const loaded = await registry.load(grammar.id)
        expect(loaded?.id).toBe(grammar.id)
        loaded?.highlighter.codeToTokens('x\n', {
          lang: grammar.id,
          theme: 'dark-plus',
        })
      } catch (error) {
        throw new Error(`Shiki grammar ${grammar.id} is incompatible`, {
          cause: error,
        })
      }
    }
  }, 30_000)
})

function registryFixture(): {
  readonly registry: ViewerGrammarRegistry
  readonly grammar: ViewerGrammarDefinition
  readonly loadLanguage: ReturnType<typeof vi.fn<HighlighterCore['loadLanguage']>>
} {
  const grammar: ViewerGrammarDefinition = {
    id: 'docker',
    aliases: ['dockerfile'],
    load: vi.fn(() => Promise.resolve({ default: [] })),
  }
  const loadLanguage = vi.fn<HighlighterCore['loadLanguage']>(() => Promise.resolve())
  const highlighter = { loadLanguage } as unknown as HighlighterCore
  const registry = new ViewerGrammarRegistry(Promise.resolve(highlighter), (name) =>
    name === 'docker' || name === 'dockerfile' ? grammar : undefined,
  )
  return { registry, grammar, loadLanguage }
}
