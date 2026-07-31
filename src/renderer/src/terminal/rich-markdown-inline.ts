import {
  appendRichMarkdownSpan,
  RICH_MARKDOWN_LIMITS,
  richMarkdownSpan,
  type RichMarkdownLink,
  type RichMarkdownSpan,
  type RichMarkdownStyle,
} from './rich-markdown-model'
import { richMarkdownUtf8Bytes, takeRichMarkdownUtf8Prefix } from './rich-markdown-source'

export interface RichMarkdownInlineOptions {
  readonly styled: boolean
  readonly resolveFileLink?: (target: string) => RichMarkdownLink | undefined
}

export function parseRichMarkdownInline(
  value: string,
  options: RichMarkdownInlineOptions,
  inherited: readonly RichMarkdownStyle[] = [],
  depth = 0,
): RichMarkdownSpan[] {
  if (depth >= RICH_MARKDOWN_LIMITS.nesting || !value) {
    return [richMarkdownSpan(value, inherited, options.styled)]
  }
  const spans: RichMarkdownSpan[] = []
  let plain = ''
  const flush = (): void => {
    if (!plain) return
    appendRichMarkdownSpan(spans, richMarkdownSpan(plain, inherited, options.styled))
    plain = ''
  }

  for (let index = 0; index < value.length;) {
    if (
      value[index] === '\\' &&
      index + 1 < value.length &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(value[index + 1] ?? '')
    ) {
      plain += value[index + 1]
      index += 2
      continue
    }

    const ticks = repeatedMarker(value, index, '`')
    if (ticks > 0) {
      const close = value.indexOf('`'.repeat(ticks), index + ticks)
      if (close >= 0) {
        flush()
        appendRichMarkdownSpan(
          spans,
          richMarkdownSpan(
            value.slice(index + ticks, close),
            [...inherited, 'code'],
            options.styled,
          ),
        )
        index = close + ticks
        continue
      }
    }

    if (value[index] === '[') {
      const parsed = parseLink(value, index)
      if (parsed) {
        flush()
        const link = resolveLink(parsed.target, options)
        const label =
          richMarkdownUtf8Bytes(parsed.label) <= RICH_MARKDOWN_LIMITS.linkLabelBytes
            ? parsed.label
            : takeRichMarkdownUtf8Prefix(
                parsed.label,
                RICH_MARKDOWN_LIMITS.linkLabelBytes,
              )[0]
        for (const span of parseRichMarkdownInline(
          label,
          options,
          inherited,
          depth + 1,
        )) {
          appendRichMarkdownSpan(spans, {
            ...span,
            styles: link ? styleSet(span.styles, 'link', options.styled) : span.styles,
            ...(link ? { link } : {}),
          })
        }
        index = parsed.end
        continue
      }
    }

    const strongMarker =
      value.startsWith('**', index) || value.startsWith('__', index)
        ? value.slice(index, index + 2)
        : undefined
    if (strongMarker) {
      const close = value.indexOf(strongMarker, index + 2)
      if (close > index + 2) {
        flush()
        for (const span of parseRichMarkdownInline(
          value.slice(index + 2, close),
          options,
          [...inherited, 'strong'],
          depth + 1,
        )) {
          appendRichMarkdownSpan(spans, span)
        }
        index = close + 2
        continue
      }
    }

    const marker = value[index]
    if (marker === '*' || marker === '_') {
      const close = value.indexOf(marker, index + 1)
      if (close > index + 1) {
        flush()
        for (const span of parseRichMarkdownInline(
          value.slice(index + 1, close),
          options,
          [...inherited, 'emphasis'],
          depth + 1,
        )) {
          appendRichMarkdownSpan(spans, span)
        }
        index = close + 1
        continue
      }
    }

    plain += value[index]
    index += 1
  }
  flush()
  return spans
}

function resolveLink(
  target: string,
  options: RichMarkdownInlineOptions,
): RichMarkdownLink | undefined {
  if (!target || richMarkdownUtf8Bytes(target) > RICH_MARKDOWN_LIMITS.linkTargetBytes) {
    return undefined
  }
  try {
    const url = new URL(target)
    if (url.protocol === 'https:') return { kind: 'https', target: url.toString() }
  } catch {
    // File targets and authored relative paths are resolved only by the caller.
  }
  const resolved = options.resolveFileLink?.(target)
  if (
    !resolved ||
    resolved.kind !== 'file' ||
    !resolved.target ||
    richMarkdownUtf8Bytes(resolved.target) > RICH_MARKDOWN_LIMITS.linkTargetBytes
  ) {
    return undefined
  }
  return resolved
}

function repeatedMarker(value: string, start: number, marker: string): number {
  let length = 0
  while (value[start + length] === marker) length += 1
  return length
}

function parseLink(
  value: string,
  start: number,
): { readonly label: string; readonly target: string; readonly end: number } | undefined {
  const labelEnd = value.indexOf('](', start + 1)
  if (labelEnd < 0) return undefined
  let depth = 0
  for (let index = labelEnd + 2; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && depth === 0) {
      return {
        label: value.slice(start + 1, labelEnd),
        target: value.slice(labelEnd + 2, index).trim(),
        end: index + 1,
      }
    } else if (char === ')') depth -= 1
  }
  return undefined
}

function styleSet(
  styles: readonly RichMarkdownStyle[],
  style: RichMarkdownStyle,
  styled: boolean,
): readonly RichMarkdownStyle[] {
  return styled ? [...new Set([...styles, style])] : []
}
