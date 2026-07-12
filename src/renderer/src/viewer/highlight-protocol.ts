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
