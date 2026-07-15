import { describe, expect, it } from 'vitest'

import { parseCsv } from '../src/renderer/src/viewer/csv-parser'

describe('CSV renderer parser', () => {
  it('handles quoted commas, escaped quotes, and embedded newlines', () => {
    expect(
      parseCsv('name,note\r\nAda,"hello, ""world"""\r\nLin,"two\nlines"\r\n'),
    ).toEqual({
      rows: [
        ['name', 'note'],
        ['Ada', 'hello, "world"'],
        ['Lin', 'two\nlines'],
      ],
      totalRows: 3,
      truncated: false,
    })
  })

  it('bounds rows and columns returned to the renderer', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5,6', 2, 2)).toEqual({
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
      totalRows: 3,
      truncated: true,
    })
  })

  it('rejects malformed quoted data', () => {
    expect(() => parseCsv('a,"unfinished')).toThrow('Unterminated quoted field')
  })
})
