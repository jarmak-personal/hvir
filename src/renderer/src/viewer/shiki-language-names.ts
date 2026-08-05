import { languageAliasNames, languageNames } from '@shikijs/langs'
import type { BundledLanguage } from 'shiki/langs'

// Shiki publishes these embedded/injection modules beside standalone grammars,
// but they are not entries in its bundled language loader catalog.
const NON_STANDALONE_LANGUAGE_NAMES = new Set([
  'angular-expression',
  'angular-inline-style',
  'angular-inline-template',
  'angular-let-declaration',
  'angular-template',
  'angular-template-blocks',
  'cpp-macro',
  'es-tag-css',
  'es-tag-glsl',
  'es-tag-html',
  'es-tag-sql',
  'es-tag-xml',
  'jinja-html',
  'markdown-nix',
  'markdown-vue',
  'vue-directives',
  'vue-interpolations',
  'vue-sfc-style-variable-injection',
])

// These valid Shiki aliases cannot be package entry names, so the lightweight
// @shikijs/langs name arrays omit them even though the bundled catalog accepts them.
const NON_MODULE_LANGUAGE_ALIASES = ['c++', 'c#', 'f#', '文言']

export const VIEWER_GRAMMAR_NAMES: ReadonlySet<string> = new Set(
  [...languageNames, ...languageAliasNames, ...NON_MODULE_LANGUAGE_ALIASES].filter(
    (name) => !NON_STANDALONE_LANGUAGE_NAMES.has(name),
  ),
)

export function viewerGrammarName(name: string): BundledLanguage | undefined {
  const normalized = name.trim().toLowerCase()
  return VIEWER_GRAMMAR_NAMES.has(normalized)
    ? (normalized as BundledLanguage)
    : undefined
}
