/**
 * Bounded, append-only Markdown presentation for provider-identified assistant text.
 *
 * This lifecycle owner knows nothing about PTYs, providers, IPC, React, or Ghostty.
 * Inline syntax, source safety, and monospace layout remain narrow collaborators.
 */

import { parseRichMarkdownInline } from './rich-markdown-inline'
import {
  boundedRichMarkdownWidth,
  richMarkdownNestingDepth,
  richMarkdownRowWidth,
  richMarkdownVisibleWidth,
  wrapRichMarkdownLine,
} from './rich-markdown-layout'
import {
  RICH_MARKDOWN_LIMITS,
  richMarkdownPlainText,
  richMarkdownSpan,
  type RichMarkdownAbortReason,
  type RichMarkdownPresentationOptions,
  type RichMarkdownRow,
  type RichMarkdownRowKind,
  type RichMarkdownStyle,
  type RichMarkdownUpdate,
} from './rich-markdown-model'
import {
  RichMarkdownSourceSanitizer,
  richMarkdownUtf8Bytes,
  takeRichMarkdownUtf8Prefix,
} from './rich-markdown-source'

export { RICH_MARKDOWN_LIMITS, richMarkdownPlainText, richMarkdownRowWidth }
export type {
  RichMarkdownAbortReason,
  RichMarkdownLink,
  RichMarkdownPresentationOptions,
  RichMarkdownRow,
  RichMarkdownRowKind,
  RichMarkdownSpan,
  RichMarkdownStyle,
  RichMarkdownUpdate,
} from './rich-markdown-model'

interface Fence {
  readonly marker: '`' | '~'
  readonly length: number
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u
const UNORDERED_LIST = /^(\s*)([-+*])[ \t]+(.*)$/u
const ORDERED_LIST = /^(\s*)(\d{1,4}[.)])[ \t]+(.*)$/u
const BLOCKQUOTE = /^(\s*)(>{1,})(?:[ \t]?)(.*)$/u
const HORIZONTAL_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u

export class StreamingMarkdownPresentation {
  private readonly width: number
  private readonly styled: boolean
  private readonly resolveFileLink: RichMarkdownPresentationOptions['resolveFileLink']
  private readonly source = new RichMarkdownSourceSanitizer()
  private state: RichMarkdownUpdate['state'] = 'streaming'
  private reason?: RichMarkdownAbortReason
  private carry = ''
  private messageBytes = 0
  private fence?: Fence

  constructor(options: RichMarkdownPresentationOptions = {}) {
    this.width = boundedRichMarkdownWidth(options.width ?? 80)
    this.styled = options.styled !== false
    this.resolveFileLink = options.resolveFileLink
  }

  append(chunk: string): RichMarkdownUpdate {
    if (this.state !== 'streaming') return this.update([])
    const sanitized = this.source.push(chunk)
    const bytes = richMarkdownUtf8Bytes(sanitized)
    if (bytes > RICH_MARKDOWN_LIMITS.recordBytes) {
      return this.abort('record-too-large')
    }
    if (this.messageBytes + bytes > RICH_MARKDOWN_LIMITS.messageBytes) {
      return this.abort('message-too-large')
    }
    this.messageBytes += bytes
    this.carry += sanitized

    const rows: RichMarkdownRow[] = []
    let newline = this.carry.indexOf('\n')
    while (newline >= 0) {
      const line = this.carry.slice(0, newline)
      this.carry = this.carry.slice(newline + 1)
      rows.push(...this.presentLine(line))
      newline = this.carry.indexOf('\n')
    }
    rows.push(...this.flushCarryOverflow())
    return this.update(rows)
  }

  end(): RichMarkdownUpdate {
    if (this.state !== 'streaming') return this.update([])
    this.finishSource()
    if (this.messageBytes > RICH_MARKDOWN_LIMITS.messageBytes) {
      return this.abort('message-too-large')
    }
    const rows: RichMarkdownRow[] = []
    if (this.carry) rows.push(...this.presentLine(this.carry))
    this.carry = ''
    if (this.fence) {
      rows.push(row('code-boundary', '└'))
      this.fence = undefined
    }
    this.state = 'ended'
    return this.update(rows)
  }

  abort(reason: RichMarkdownAbortReason): RichMarkdownUpdate {
    if (this.state !== 'streaming') return this.update([])
    this.finishSource()
    const rows = this.carry
      ? wrapRichMarkdownLine(
          {
            kind: 'paragraph',
            prefix: '',
            continuationPrefix: '',
            spans: [richMarkdownSpan(this.carry)],
          },
          this.width,
        )
      : []
    this.carry = ''
    this.fence = undefined
    this.state = 'aborted'
    this.reason = reason
    rows.push(
      row(
        'status',
        '',
        richMarkdownSpan(`[response interrupted: ${reason.replaceAll('-', ' ')}]`),
      ),
    )
    return this.update(rows)
  }

  private update(rows: readonly RichMarkdownRow[]): RichMarkdownUpdate {
    return {
      state: this.state,
      rows,
      ...(this.reason ? { reason: this.reason } : {}),
    }
  }

  private finishSource(): void {
    const suffix = this.source.finish()
    this.carry += suffix
    this.messageBytes += richMarkdownUtf8Bytes(suffix)
  }

  private flushCarryOverflow(): RichMarkdownRow[] {
    const rows: RichMarkdownRow[] = []
    while (richMarkdownUtf8Bytes(this.carry) > RICH_MARKDOWN_LIMITS.carryBytes) {
      const [prefix, suffix] = takeRichMarkdownUtf8Prefix(
        this.carry,
        RICH_MARKDOWN_LIMITS.carryBytes,
      )
      this.carry = suffix
      rows.push(
        ...wrapRichMarkdownLine(
          {
            kind: this.fence ? 'code' : 'paragraph',
            prefix: this.fence ? '  ' : '',
            continuationPrefix: this.fence ? '  ' : '',
            spans: [
              richMarkdownSpan(
                prefix.replaceAll('\t', '    '),
                this.fence ? ['code'] : [],
                this.styled,
              ),
            ],
          },
          this.width,
        ),
      )
    }
    return rows
  }

  private presentLine(sourceLine: string): RichMarkdownRow[] {
    const line = sourceLine.replaceAll('\t', '    ')
    if (this.fence) return this.presentCodeLine(line)

    const opening = line.match(OPEN_FENCE)
    if (opening?.[1]) {
      const marker = opening[1][0]
      if (marker === '`' || marker === '~') {
        this.fence = { marker, length: opening[1].length }
        const info = opening[2]?.trim().slice(0, 80) ?? ''
        return [
          row(
            'code-boundary',
            info ? '┌ ' : '┌',
            ...(info ? [richMarkdownSpan(info, ['code'], this.styled)] : []),
          ),
        ]
      }
    }

    if (HORIZONTAL_RULE.test(line)) {
      return [row('rule', '─'.repeat(Math.max(3, Math.min(this.width, 32))))]
    }

    const heading = line.match(HEADING)
    if (heading) {
      return this.wrapInline('heading', '▸ ', '  ', heading[2] ?? '', ['heading'])
    }

    const unordered = line.match(UNORDERED_LIST)
    if (unordered) {
      const prefix = `${'  '.repeat(richMarkdownNestingDepth(unordered[1] ?? ''))}• `
      return this.wrapInline(
        'list-item',
        prefix,
        ' '.repeat(richMarkdownVisibleWidth(prefix)),
        unordered[3] ?? '',
      )
    }

    const ordered = line.match(ORDERED_LIST)
    if (ordered) {
      const prefix = `${'  '.repeat(richMarkdownNestingDepth(ordered[1] ?? ''))}${ordered[2]} `
      return this.wrapInline(
        'list-item',
        prefix,
        ' '.repeat(richMarkdownVisibleWidth(prefix)),
        ordered[3] ?? '',
      )
    }

    const quote = line.match(BLOCKQUOTE)
    if (quote) {
      const level = Math.min(RICH_MARKDOWN_LIMITS.nesting, quote[2]?.length ?? 1)
      const prefix = '│ '.repeat(level)
      return this.wrapInline(
        'blockquote',
        prefix,
        ' '.repeat(richMarkdownVisibleWidth(prefix)),
        quote[3] ?? '',
        ['quote'],
      )
    }

    return this.wrapInline('paragraph', '', '', line)
  }

  private presentCodeLine(line: string): RichMarkdownRow[] {
    const fence = this.fence
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1]
    if (
      fence &&
      closing &&
      closing[0] === fence.marker &&
      closing.length >= fence.length
    ) {
      this.fence = undefined
      return [row('code-boundary', '└')]
    }
    return wrapRichMarkdownLine(
      {
        kind: 'code',
        prefix: '  ',
        continuationPrefix: '  ',
        spans: [richMarkdownSpan(line, ['code'], this.styled)],
      },
      this.width,
    )
  }

  private wrapInline(
    kind: RichMarkdownRowKind,
    prefix: string,
    continuationPrefix: string,
    value: string,
    inherited: readonly RichMarkdownStyle[] = [],
  ): RichMarkdownRow[] {
    return wrapRichMarkdownLine(
      {
        kind,
        prefix,
        continuationPrefix,
        spans: parseRichMarkdownInline(
          value,
          {
            styled: this.styled,
            ...(this.resolveFileLink ? { resolveFileLink: this.resolveFileLink } : {}),
          },
          inherited,
        ),
      },
      this.width,
    )
  }
}

function row(
  kind: RichMarkdownRowKind,
  prefix: string,
  ...spans: ReturnType<typeof richMarkdownSpan>[]
): RichMarkdownRow {
  return { kind, prefix, spans }
}
