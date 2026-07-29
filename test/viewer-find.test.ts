import { describe, expect, it } from 'vitest'

import {
  findLiteralRanges,
  normalizeFindIndex,
} from '../src/renderer/src/viewer/viewer-find'

describe('viewer find semantics', () => {
  it('finds literal non-overlapping matches without case sensitivity by default', () => {
    expect(
      findLiteralRanges('Alpha alpha ALPHA', {
        text: 'alpha',
        caseSensitive: false,
      }),
    ).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ])
    expect(findLiteralRanges('aaaa', { text: 'aa', caseSensitive: true })).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ])
  })

  it('honors match case and treats regular-expression syntax literally', () => {
    expect(
      findLiteralRanges('A.b a.b aXb', { text: 'a.b', caseSensitive: true }),
    ).toEqual([{ from: 4, to: 7 }])
  })

  it('wraps next and previous indexes deterministically', () => {
    expect(normalizeFindIndex(3, 3)).toBe(0)
    expect(normalizeFindIndex(-1, 3)).toBe(2)
    expect(normalizeFindIndex(-4, 3)).toBe(2)
    expect(normalizeFindIndex(8, 3)).toBe(2)
    expect(normalizeFindIndex(12, 0)).toBe(0)
  })
})
