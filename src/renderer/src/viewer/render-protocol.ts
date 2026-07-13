export interface MarkdownRenderRequest {
  readonly id: number
  readonly markdown: string
}

export type MarkdownRenderResponse =
  | { readonly id: number; readonly ok: true; readonly html: string }
  | { readonly id: number; readonly ok: false; readonly error: string }

export const MARKDOWN_OPTIONS = {
  html: false,
  linkify: false,
  typographer: true,
} as const
