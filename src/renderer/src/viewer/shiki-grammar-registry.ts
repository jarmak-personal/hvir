import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import {
  resolveViewerGrammar,
  type ViewerGrammarDefinition,
} from './shiki-language-catalog'

export interface LoadedViewerGrammar {
  readonly id: ViewerGrammarDefinition['id']
  readonly highlighter: HighlighterCore
}

export type ViewerGrammarResolver = (name: string) => ViewerGrammarDefinition | undefined

export class ViewerGrammarRegistry {
  private readonly registrations = new Map<
    ViewerGrammarDefinition['id'],
    Promise<HighlighterCore>
  >()

  constructor(
    private readonly highlighter: Promise<HighlighterCore>,
    private readonly resolve: ViewerGrammarResolver = resolveViewerGrammar,
  ) {}

  async load(name: string): Promise<LoadedViewerGrammar | undefined> {
    const grammar = this.resolve(name)
    if (!grammar) return undefined

    let registration = this.registrations.get(grammar.id)
    if (!registration) {
      registration = this.register(grammar)
      this.registrations.set(grammar.id, registration)
      void registration.catch(() => {
        if (this.registrations.get(grammar.id) === registration) {
          this.registrations.delete(grammar.id)
        }
      })
    }

    return { id: grammar.id, highlighter: await registration }
  }

  private async register(grammar: ViewerGrammarDefinition): Promise<HighlighterCore> {
    const highlighter = await this.highlighter
    await highlighter.loadLanguage(grammar.load)
    return highlighter
  }
}

export function createViewerGrammarRegistry(): ViewerGrammarRegistry {
  return new ViewerGrammarRegistry(
    createHighlighterCore({
      themes: [
        import('@shikijs/themes/dark-plus'),
        import('@shikijs/themes/github-light-default'),
      ],
      langs: [],
      // The JS engine is worker-friendly and avoids a second WASM startup cost.
      engine: createJavaScriptRegexEngine(),
    }),
  )
}
