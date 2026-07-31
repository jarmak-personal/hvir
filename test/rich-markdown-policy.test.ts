import { describe, expect, it } from 'vitest'

import {
  RICH_MARKDOWN_LIMITS,
  StreamingMarkdownPresentation,
  richMarkdownPlainText,
  richMarkdownRowWidth,
  type RichMarkdownLink,
  type RichMarkdownRow,
} from '../src/renderer/src/terminal/rich-markdown-policy'

const fileLink = (target: string): RichMarkdownLink | undefined =>
  target.startsWith('file:')
    ? { kind: 'file', target: target.slice('file:'.length) }
    : undefined

function render(
  chunks: readonly string[],
  options: ConstructorParameters<typeof StreamingMarkdownPresentation>[0] = {},
): readonly RichMarkdownRow[] {
  const policy = new StreamingMarkdownPresentation(options)
  const rows = chunks.flatMap((chunk) => policy.append(chunk).rows)
  return [...rows, ...policy.end().rows]
}

describe('streaming rich Markdown presentation', () => {
  it('is invariant across valid chunk boundaries for the accepted subset', () => {
    const markdown = [
      '# Heading',
      '',
      'A **strong** and *quiet* line with `code` and [docs](https://example.com/a).',
      '- first item',
      '12. ordered item',
      '> quoted **text**',
      '---',
      '```ts',
      'const answer = 42',
      '```',
      '',
    ].join('\n')
    const expected = render([markdown], { width: 80 })
    const codePointChunks = Array.from(markdown)
    const unevenChunks = [
      markdown.slice(0, 2),
      markdown.slice(2, 19),
      markdown.slice(19, 53),
      markdown.slice(53, 97),
      markdown.slice(97),
    ]

    expect(render(codePointChunks, { width: 80 })).toEqual(expected)
    expect(render(unevenChunks, { width: 80 })).toEqual(expected)
  })

  it('emits stable block lines before end and retains one incomplete line', () => {
    const policy = new StreamingMarkdownPresentation({ width: 48 })

    const first = policy.append('# Heading\n- list item\n[doc')
    expect(first.state).toBe('streaming')
    expect(first.rows.map(richMarkdownPlainText)).toEqual(['▸ Heading', '• list item'])

    expect(policy.append('s](https://example.com)').rows).toEqual([])
    const link = policy.append('\n')
    expect(link.rows.map(richMarkdownPlainText)).toEqual(['docs'])
    expect(link.rows[0]?.spans[0]?.link).toEqual({
      kind: 'https',
      target: 'https://example.com/',
    })
  })

  it('flushes incomplete constructs predictably on end and literally on abort', () => {
    const ended = new StreamingMarkdownPresentation({ width: 40 })
    ended.append('partial **strong')
    expect(ended.end().rows.map(richMarkdownPlainText)).toEqual(['partial **strong'])

    const aborted = new StreamingMarkdownPresentation({ width: 40 })
    aborted.append('partial *emphasis')
    expect(aborted.abort('source-lost').rows.map(richMarkdownPlainText)).toEqual([
      'partial *emphasis',
      '[response interrupted: source lost]',
    ])
    expect(aborted.append('late').state).toBe('aborted')
  })

  it('removes source terminal controls before producing styled output', () => {
    const source =
      '# safe\u001b[31m red\u009b31m\n' +
      'osc \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\n' +
      'dcs \u001bPpayload\u001b\\ end\n'
    const rows = render([source], { width: 100 })
    const visible = rows.map(richMarkdownPlainText).join('\n')

    expect(hasUnsafeControl(visible)).toBe(false)
    expect(visible).not.toContain('\u001b')
    expect(visible).toContain('safe�[31m red�31m')
    expect(visible).toContain('osc �]8;;https://evil.example�link�]8;;�')
    expect(visible).toContain('dcs �Ppayload�\\ end')
  })

  it('keeps narrow list wrapping bounded with hanging indentation', () => {
    const rows = render(['- alpha beta gamma delta epsilon zeta eta theta\n'], {
      width: 14,
    })

    expect(rows.length).toBeGreaterThan(2)
    expect(richMarkdownPlainText(rows[0] ?? fail())).toMatch(/^• /)
    for (const row of rows.slice(1)) {
      expect(richMarkdownPlainText(row)).toMatch(/^ {2}/)
    }
    for (const row of rows) expect(richMarkdownRowWidth(row)).toBeLessThanOrEqual(14)
  })

  it('retains one complete typed file target across a compact wrapped label', () => {
    const target = '/srv/project/src/features/rich-output/presentation.ts:42:7'
    const rows = render([`[presentation.ts](file:${target})\n`], {
      width: 8,
      resolveFileLink: fileLink,
    })

    expect(rows.map(richMarkdownPlainText)).toEqual(['presenta', 'tion.ts'])
    const links = rows.flatMap((row) => row.spans.map((span) => span.link))
    expect(links).toEqual([
      { kind: 'file', target },
      { kind: 'file', target },
    ])
    expect(rows.map(richMarkdownPlainText).join('')).toBe('presentation.ts')
  })

  it('rejects unsafe or oversized link destinations as ordinary visible text', () => {
    const oversized = `https://example.com/${'x'.repeat(RICH_MARKDOWN_LIMITS.linkTargetBytes)}`
    const rows = render(
      [
        '[script](javascript:alert(1))\n',
        `[large](${oversized})\n`,
        '[outside](file:/etc/passwd)\n',
      ],
      {
        width: 120,
        resolveFileLink: () => undefined,
      },
    )

    expect(rows.map(richMarkdownPlainText)).toEqual(['script', 'large', 'outside'])
    expect(rows.flatMap((row) => row.spans).every((span) => !span.link)).toBe(true)
  })

  it('handles Unicode split at UTF-16 boundaries without changing visible text', () => {
    const value = 'emoji 😀 combining e\u0301 and 界\n'
    const split = value.indexOf('😀') + 1
    expect(render([value.slice(0, split), value.slice(split)], { width: 80 })).toEqual(
      render([value], { width: 80 }),
    )
  })

  it('bounds carry and message bodies with deterministic readable overflow', () => {
    const carry = new StreamingMarkdownPresentation({ width: 80 })
    const longLine = 'x'.repeat(RICH_MARKDOWN_LIMITS.carryBytes + 10)
    const emitted = carry.append(longLine)
    expect(emitted.rows.length).toBeGreaterThan(0)
    expect(emitted.rows.every((row) => richMarkdownRowWidth(row) <= 80)).toBe(true)
    expect(
      emitted.rows.map(richMarkdownPlainText).join('') +
        carry.end().rows.map(richMarkdownPlainText).join(''),
    ).toBe(longLine)

    const message = new StreamingMarkdownPresentation({ width: 80 })
    for (
      let accepted = 0;
      accepted < RICH_MARKDOWN_LIMITS.messageBytes;
      accepted += RICH_MARKDOWN_LIMITS.recordBytes
    ) {
      message.append('x'.repeat(RICH_MARKDOWN_LIMITS.recordBytes))
    }
    const overflow = message.append('x')
    expect(overflow.state).toBe('aborted')
    expect(overflow.reason).toBe('message-too-large')
    expect(overflow.rows.at(-1)).toMatchObject({ kind: 'status' })
  })

  it('rejects one oversized source record without retaining its body', () => {
    const policy = new StreamingMarkdownPresentation({ width: 80 })
    const overflow = policy.append('x'.repeat(RICH_MARKDOWN_LIMITS.recordBytes + 1))

    expect(overflow).toMatchObject({
      state: 'aborted',
      reason: 'record-too-large',
    })
    expect(overflow.rows.map(richMarkdownPlainText)).toEqual([
      '[response interrupted: record too large]',
    ])
  })

  it('uses structural text when styling is disabled', () => {
    const rows = render(['## Heading\n> quote\n```txt\ncode\n```\n'], {
      styled: false,
      width: 40,
    })

    expect(rows.map(richMarkdownPlainText)).toEqual([
      '▸ Heading',
      '│ quote',
      '┌ txt',
      '  code',
      '└',
    ])
    expect(
      rows.flatMap((row) => row.spans).every((span) => span.styles.length === 0),
    ).toBe(true)
  })

  it('caps block nesting independently of authored depth', () => {
    const rows = render([`${'>'.repeat(32)} deeply nested\n`], { width: 80 })
    const visible = richMarkdownPlainText(rows[0] ?? fail())

    expect(visible.startsWith('│ '.repeat(RICH_MARKDOWN_LIMITS.nesting))).toBe(true)
    expect(visible).not.toContain('>')
  })
})

function fail(): never {
  throw new Error('Expected a row')
}

function hasUnsafeControl(value: string): boolean {
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0
    if (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}
