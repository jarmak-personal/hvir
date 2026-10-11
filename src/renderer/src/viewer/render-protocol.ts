export interface MarkdownRenderRequest {
  readonly id: number
  readonly markdown: string
  readonly theme: 'dark' | 'light'
  readonly resources?: 'inert'
}

export type MarkdownRenderResponse =
  | { readonly id: number; readonly ok: true; readonly html: string }
  | { readonly id: number; readonly ok: false; readonly error: string }

export { MARKDOWN_OPTIONS } from '../../../shared/presentation/document-markdown/contract'
