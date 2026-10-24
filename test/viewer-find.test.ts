import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import {
  findLiteralRanges,
  canFindImmediately,
  normalizeFindIndex,
  viewerFindUnavailable,
} from '../src/renderer/src/viewer/viewer-find'
import { localPath, type ReadFileResponse, type ViewMode } from '../src/shared'

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

  it('bounds immediate search by combined documents and normalized query work', () => {
    const query = { text: 'x', caseSensitive: false }
    const doc = (value: string) => Text.of([value])
    expect(canFindImmediately([doc('x'.repeat(2048))], query)).toBe(true)
    expect(canFindImmediately([doc('x'.repeat(2049))], query)).toBe(false)
    expect(
      canFindImmediately([doc('x'.repeat(1024)), doc('x'.repeat(1025))], query),
    ).toBe(false)
    expect(
      canFindImmediately([doc('x'.repeat(2048))], { ...query, text: 'x'.repeat(16) }),
    ).toBe(true)
    expect(
      canFindImmediately([doc('x'.repeat(2048))], { ...query, text: 'x'.repeat(17) }),
    ).toBe(false)
    expect(canFindImmediately([doc('x')], { ...query, text: 'x'.repeat(65) })).toBe(false)
    // NFKD expands each ligature to three code units, including in the query.
    expect(canFindImmediately([doc('ﬃ'.repeat(2048))], { ...query, text: 'ﬃﬃ' })).toBe(
      false,
    )
  })

  it('wraps next and previous indexes deterministically', () => {
    expect(normalizeFindIndex(3, 3)).toBe(0)
    expect(normalizeFindIndex(-1, 3)).toBe(2)
    expect(normalizeFindIndex(-4, 3)).toBe(2)
    expect(normalizeFindIndex(8, 3)).toBe(2)
    expect(normalizeFindIndex(12, 0)).toBe(0)
  })

  it('reports unsupported representations without hiding supported rendered text', () => {
    expect(unavailable('/repo/file.bin', 'rendered', true)).toBe(
      'In-file find is unavailable for binary files',
    )
    expect(unavailable('/repo/image.png', 'rendered', true)).toBe(
      'In-file find is unavailable for images',
    )
    expect(unavailable('/repo/index.html', 'rendered')).toBe(
      'In-file find is unavailable in live rendered HTML',
    )
    expect(unavailable('/repo/index.html', 'source')).toBeUndefined()
    for (const path of [
      '/repo/readme.md',
      '/repo/data.json',
      '/repo/data.yml',
      '/repo/data.csv',
      '/repo/diagram.mmd',
    ]) {
      expect(unavailable(path, 'rendered')).toBeUndefined()
    }
    expect(unavailable('/repo/plain.txt', 'rendered')).toBe(
      'In-file find is unavailable in this rendered view',
    )
  })

  it('reports loading before representation availability', () => {
    const path = localPath('/repo/readme.md')
    expect(viewerFindUnavailable({ path, mode: 'rendered', loading: true })).toBe(
      'In-file find is unavailable while the file loads',
    )
  })
})

function unavailable(
  pathValue: string,
  mode: ViewMode,
  binary = false,
): string | undefined {
  const path = localPath(pathValue)
  const file: ReadFileResponse = {
    path,
    content: '',
    size: 0,
    mtimeMs: 0,
    binary,
  }
  return viewerFindUnavailable({ path, mode, loading: false, file })
}
