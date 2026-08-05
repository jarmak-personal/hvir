import type { BundledLanguage } from 'shiki/langs'

import { viewerGrammarName } from './shiki-language-names'

export interface HighlightRequest {
  readonly id: number
  readonly code: string
  readonly language: HighlightLanguage
  readonly theme: 'dark' | 'light'
}

export type HighlightLanguage = BundledLanguage

const EXTENSION_OVERRIDES: Readonly<Record<string, string>> = {
  htm: 'html',
}

const AMBIGUOUS_EXTENSIONS = new Set(['ps', 'v'])

const SPECIAL_FILENAMES: Readonly<Record<string, string>> = {
  '.env': 'dotenv',
  bsdmakefile: 'make',
  'cmakelists.txt': 'cmake',
  codeowners: 'codeowners',
  dockerfile: 'docker',
  gemfile: 'ruby',
  gnumakefile: 'make',
  jenkinsfile: 'groovy',
  justfile: 'just',
  makefile: 'make',
  'nginx.conf': 'nginx',
  rakefile: 'ruby',
  ssh_config: 'ssh-config',
  sshd_config: 'ssh-config',
  vagrantfile: 'ruby',
}

const FALLBACK_SPECIAL_FILENAME_PREFIXES: readonly (readonly [string, string])[] = [
  ['.env.', 'dotenv'],
  ['justfile.', 'just'],
  ['makefile.', 'make'],
]

export function languageForPath(path: string): HighlightLanguage | undefined {
  const normalized = path.toLowerCase()
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const special = SPECIAL_FILENAMES[name]
  if (special) return viewerGrammarName(special)

  // Dockerfile.* is an explicit association even when its suffix is also a grammar name.
  if (name.startsWith('dockerfile.')) return viewerGrammarName('docker')

  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const extensionLanguage =
    extension && !AMBIGUOUS_EXTENSIONS.has(extension)
      ? viewerGrammarName(EXTENSION_OVERRIDES[extension] ?? extension)
      : undefined
  if (extensionLanguage) return extensionLanguage

  for (const [prefix, language] of FALLBACK_SPECIAL_FILENAME_PREFIXES) {
    if (name.startsWith(prefix)) return viewerGrammarName(language)
  }

  return undefined
}

export interface HighlightToken {
  readonly from: number
  readonly to: number
  readonly color?: string
  readonly backgroundColor?: string
  readonly fontStyle?: number
}

export type HighlightResponse =
  | { readonly type: 'batch'; readonly id: number; readonly tokens: HighlightToken[] }
  | {
      readonly type: 'done'
      readonly id: number
      readonly language: HighlightLanguage
    }
  | { readonly type: 'plain'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly message: string }
