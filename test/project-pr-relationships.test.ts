import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  parseCompletingChildTrailer,
  parseContributionTrailers,
} from '../scripts/project-management/pull-request-relationships.ts'

describe('pull request contribution trailers', () => {
  it('accepts exact whole-line trailers, normalizes CRLF, and sorts targets', () => {
    expect(
      parseContributionTrailers(
        'Summary\r\n\r\n  Contributes-to: #90  \r\nContributes-to: #12',
        100,
      ),
    ).toEqual({ issueNumbers: [12, 90], warnings: [], errors: [] })
  })

  it('deduplicates repeated trailers with an actionable warning', () => {
    expect(
      parseContributionTrailers('Contributes-to: #12\nContributes-to: #12', 100),
    ).toEqual({
      issueNumbers: [12],
      warnings: [{ code: 'duplicate-trailer', line: 2, issueNumber: 12 }],
      errors: [],
    })
  })

  it.each([
    'contributes-to: #12',
    'Contributes-to:#12',
    'Contributes-to: owner/repository#12',
    'Contributes-to: #0',
    'Contributes-to: #12 extra',
    'Contributes-to: #999999999999999999999999',
  ])('rejects a malformed trailer without interpreting its text: %s', (line) => {
    const parsed = parseContributionTrailers(line, 100)
    expect(parsed.issueNumbers).toEqual([])
    expect(parsed.errors).toEqual([{ code: 'malformed-trailer', line: 1 }])
  })

  it('rejects a PR-number self reference and ignores free-form prose', () => {
    expect(
      parseContributionTrailers('This PR contributes to #20.\nContributes-to: #20', 20),
    ).toEqual({
      issueNumbers: [],
      warnings: [],
      errors: [{ code: 'self-reference', line: 2, issueNumber: 20 }],
    })
  })

  it('ignores relationship examples in code fences, indented code, and comments', () => {
    const body = [
      '```text',
      'Contributes-to: #10',
      '```',
      '    Contributes-to: #11',
      '<!--',
      'Contributes-to: #12',
      '-->',
      '<!-- Contributes-to: #13 -->',
    ].join('\n')
    expect(parseContributionTrailers(body, 99)).toEqual({
      issueNumbers: [],
      warnings: [],
      errors: [],
    })
  })

  it('does not let comment syntax inside a code fence hide a later trailer', () => {
    const body = [
      '```html',
      '<!-- an intentionally unclosed example',
      '```',
      'Contributes-to: #14',
    ].join('\n')
    expect(parseContributionTrailers(body, 99)).toMatchObject({
      issueNumbers: [14],
      errors: [],
    })
  })

  it('does not interpret the PR template guidance as a relationship', () => {
    const template = readFileSync(
      new URL('../.github/pull_request_template.md', import.meta.url),
      'utf8',
    )
    expect(parseContributionTrailers(template, 999)).toEqual({
      issueNumbers: [],
      warnings: [],
      errors: [],
    })
    expect(parseCompletingChildTrailer(template, 999)).toEqual({ errors: [] })
  })
})

describe('completing-child trailer', () => {
  it('accepts one exact direct-child relationship', () => {
    expect(parseCompletingChildTrailer('Completes-child: #168', 200)).toEqual({
      issueNumber: 168,
      errors: [],
    })
  })

  it('rejects duplicate or competing child declarations', () => {
    expect(
      parseCompletingChildTrailer('Completes-child: #168\nCompletes-child: #169', 200),
    ).toEqual({
      errors: [
        {
          code: 'multiple-completing-children',
          line: 2,
          issueNumber: 169,
        },
      ],
    })
  })

  it.each([
    'completes-child: #168',
    'Completes-child:#168',
    'Completes-child: owner/repository#168',
    'Completes-child: #0',
  ])('rejects malformed completion metadata: %s', (line) => {
    expect(parseCompletingChildTrailer(line, 200)).toEqual({
      errors: [{ code: 'malformed-completing-child', line: 1 }],
    })
  })

  it('ignores examples inside comments and fences', () => {
    const body = [
      '<!-- Completes-child: #168 -->',
      '```text',
      'Completes-child: #169',
      '```',
    ].join('\n')
    expect(parseCompletingChildTrailer(body, 200)).toEqual({ errors: [] })
  })
})
