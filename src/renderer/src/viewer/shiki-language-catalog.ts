import { bundledLanguagesInfo, type BundledLanguage } from 'shiki/langs'

export interface ViewerGrammarDefinition {
  readonly id: BundledLanguage
  readonly aliases: readonly BundledLanguage[]
  readonly load: (typeof bundledLanguagesInfo)[number]['import']
}

export const VIEWER_GRAMMAR_DEFINITIONS: readonly ViewerGrammarDefinition[] =
  bundledLanguagesInfo.map((grammar) => ({
    id: grammar.id as BundledLanguage,
    aliases: (grammar.aliases ?? []) as BundledLanguage[],
    load: grammar.import,
  }))

const GRAMMAR_BY_NAME = new Map<string, ViewerGrammarDefinition>()

for (const grammar of VIEWER_GRAMMAR_DEFINITIONS) {
  GRAMMAR_BY_NAME.set(grammar.id, grammar)
  for (const alias of grammar.aliases) GRAMMAR_BY_NAME.set(alias, grammar)
}

export function resolveViewerGrammar(name: string): ViewerGrammarDefinition | undefined {
  return GRAMMAR_BY_NAME.get(name.trim().toLowerCase())
}
