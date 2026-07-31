import {
  appendRichMarkdownSpan,
  RICH_MARKDOWN_LIMITS,
  richMarkdownPlainText,
  type RichMarkdownLinePresentation,
  type RichMarkdownRow,
  type RichMarkdownSpan,
} from './rich-markdown-model'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function boundedRichMarkdownWidth(width: number): number {
  if (!Number.isFinite(width)) return 80
  return Math.max(
    RICH_MARKDOWN_LIMITS.minWidth,
    Math.min(RICH_MARKDOWN_LIMITS.maxWidth, Math.floor(width)),
  )
}

export function richMarkdownNestingDepth(whitespace: string): number {
  return Math.min(
    RICH_MARKDOWN_LIMITS.nesting - 1,
    Math.floor(richMarkdownVisibleWidth(whitespace) / 2),
  )
}

export function wrapRichMarkdownLine(
  line: RichMarkdownLinePresentation,
  width: number,
): RichMarkdownRow[] {
  if (line.spans.length === 0) {
    return [{ kind: line.kind, prefix: line.prefix, spans: [] }]
  }
  const rows: RichMarkdownRow[] = []
  let prefix = line.prefix
  let available = Math.max(1, width - richMarkdownVisibleWidth(prefix))
  let rowSpans: RichMarkdownSpan[] = []
  let used = 0
  const finish = (): void => {
    rows.push({ kind: line.kind, prefix, spans: rowSpans })
    prefix = line.continuationPrefix
    available = Math.max(1, width - richMarkdownVisibleWidth(prefix))
    rowSpans = []
    used = 0
  }

  for (const span of line.spans) {
    for (const segment of graphemes.segment(span.text)) {
      const segmentWidth = graphemeWidth(segment.segment)
      if (used > 0 && used + segmentWidth > available) finish()
      appendRichMarkdownSpan(rowSpans, { ...span, text: segment.segment })
      used += segmentWidth
      if (used >= available) finish()
    }
  }
  if (rowSpans.length > 0 || rows.length === 0) finish()
  return rows
}

export function richMarkdownRowWidth(row: RichMarkdownRow): number {
  return richMarkdownVisibleWidth(richMarkdownPlainText(row))
}

export function richMarkdownVisibleWidth(value: string): number {
  let width = 0
  for (const segment of graphemes.segment(value)) {
    width += graphemeWidth(segment.segment)
  }
  return width
}

function graphemeWidth(value: string): number {
  const first = value.codePointAt(0)
  if (first === undefined || isCombining(first)) return 0
  return isWide(first) ? 2 : 1
}

function isCombining(value: number): boolean {
  return (
    (value >= 0x0300 && value <= 0x036f) ||
    (value >= 0x1ab0 && value <= 0x1aff) ||
    (value >= 0x1dc0 && value <= 0x1dff) ||
    (value >= 0x20d0 && value <= 0x20ff) ||
    (value >= 0xfe20 && value <= 0xfe2f)
  )
}

function isWide(value: number): boolean {
  return (
    value >= 0x1100 &&
    (value <= 0x115f ||
      value === 0x2329 ||
      value === 0x232a ||
      (value >= 0x2e80 && value <= 0xa4cf && value !== 0x303f) ||
      (value >= 0xac00 && value <= 0xd7a3) ||
      (value >= 0xf900 && value <= 0xfaff) ||
      (value >= 0xfe10 && value <= 0xfe19) ||
      (value >= 0xfe30 && value <= 0xfe6f) ||
      (value >= 0xff00 && value <= 0xff60) ||
      (value >= 0xffe0 && value <= 0xffe6) ||
      (value >= 0x1f300 && value <= 0x1faff) ||
      (value >= 0x20000 && value <= 0x3fffd))
  )
}
