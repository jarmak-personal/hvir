export const RICH_MARKDOWN_LIMITS = {
  recordBytes: 64 * 1024,
  messageBytes: 1024 * 1024,
  carryBytes: 8 * 1024,
  nesting: 8,
  linkLabelBytes: 4 * 1024,
  linkTargetBytes: 8 * 1024,
  minWidth: 8,
  maxWidth: 500,
} as const

export type RichMarkdownStyle =
  'heading' | 'strong' | 'emphasis' | 'code' | 'quote' | 'link'

export type RichMarkdownLink =
  | { readonly kind: 'https'; readonly target: string }
  | { readonly kind: 'file'; readonly target: string }

export interface RichMarkdownSpan {
  readonly text: string
  readonly styles: readonly RichMarkdownStyle[]
  readonly link?: RichMarkdownLink
}

export type RichMarkdownRowKind =
  | 'paragraph'
  | 'heading'
  | 'list-item'
  | 'blockquote'
  | 'code-boundary'
  | 'code'
  | 'rule'
  | 'status'

export interface RichMarkdownRow {
  readonly kind: RichMarkdownRowKind
  readonly prefix: string
  readonly spans: readonly RichMarkdownSpan[]
}

export type RichMarkdownAbortReason =
  'record-too-large' | 'message-too-large' | 'source-lost' | 'invalid-lifecycle'

export interface RichMarkdownUpdate {
  readonly state: 'streaming' | 'ended' | 'aborted'
  readonly rows: readonly RichMarkdownRow[]
  readonly reason?: RichMarkdownAbortReason
}

export interface RichMarkdownPresentationOptions {
  readonly width?: number
  readonly styled?: boolean
  readonly resolveFileLink?: (target: string) => RichMarkdownLink | undefined
}

export interface RichMarkdownLinePresentation {
  readonly kind: RichMarkdownRowKind
  readonly prefix: string
  readonly continuationPrefix: string
  readonly spans: readonly RichMarkdownSpan[]
}

export function richMarkdownPlainText(row: RichMarkdownRow): string {
  return row.prefix + row.spans.map((span) => span.text).join('')
}

export function richMarkdownSpan(
  text: string,
  styles: readonly RichMarkdownStyle[] = [],
  styled = true,
): RichMarkdownSpan {
  return {
    text,
    styles: styled ? [...new Set(styles)] : [],
  }
}

export function appendRichMarkdownSpan(
  target: RichMarkdownSpan[],
  span: RichMarkdownSpan,
): void {
  if (!span.text) return
  const previous = target.at(-1)
  if (
    previous &&
    sameStyles(previous.styles, span.styles) &&
    previous.link?.kind === span.link?.kind &&
    previous.link?.target === span.link?.target
  ) {
    target[target.length - 1] = { ...previous, text: previous.text + span.text }
  } else target.push(span)
}

function sameStyles(
  left: readonly RichMarkdownStyle[],
  right: readonly RichMarkdownStyle[],
): boolean {
  return (
    left.length === right.length && left.every((style, index) => style === right[index])
  )
}
