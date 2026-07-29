import { describe, expect, it } from 'vitest'

import {
  parseSourceCoordinate,
  resolveSourceCoordinate,
} from '../src/renderer/src/viewer/source-coordinate'

describe('source coordinates', () => {
  it('parses positive line and optional column input', () => {
    expect(parseSourceCoordinate(' 12 ')).toMatchObject({
      valid: true,
      coordinate: { line: 12 },
    })
    expect(parseSourceCoordinate('12:4')).toMatchObject({
      valid: true,
      coordinate: { line: 12, column: 4 },
    })
  })

  it.each(['', '0', '-1', '1:0', '1:-2', '1:2:3', 'line 3'])(
    'rejects malformed input %j',
    (input) => expect(parseSourceCoordinate(input).valid).toBe(false),
  )

  it('resolves exact positions without clamping lines or columns', () => {
    const content = 'alpha\r\nbeta\ngamma'
    expect(resolveSourceCoordinate(content, { line: 2, column: 3 })).toEqual({
      valid: true,
      coordinate: { line: 2, column: 3 },
      offset: 9,
    })
    expect(resolveSourceCoordinate(content, { line: 4 }).valid).toBe(false)
    expect(resolveSourceCoordinate(content, { line: 2, column: 6 }).valid).toBe(false)
  })

  it('allows the caret immediately after the final character on a line', () => {
    expect(resolveSourceCoordinate('abc\n', { line: 1, column: 4 })).toMatchObject({
      valid: true,
      offset: 3,
    })
    expect(resolveSourceCoordinate('\n', { line: 1, column: 1 }).valid).toBe(true)
  })
})
