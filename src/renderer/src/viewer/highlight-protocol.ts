export interface HighlightRequest {
  readonly id: number
  readonly code: string
  readonly language: HighlightLanguage
}

export type HighlightLanguage =
  | 'bash'
  | 'css'
  | 'go'
  | 'html'
  | 'javascript'
  | 'jsx'
  | 'json'
  | 'markdown'
  | 'python'
  | 'rust'
  | 'tsx'
  | 'typescript'

export function languageForPath(path: string): HighlightLanguage | undefined {
  const name = path.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const byExtension: Record<string, HighlightLanguage> = {
    bash: 'bash',
    cjs: 'javascript',
    css: 'css',
    cts: 'typescript',
    go: 'go',
    htm: 'html',
    html: 'html',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    mts: 'typescript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'tsx',
  }
  return byExtension[extension]
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
  | { readonly type: 'done'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly message: string }
