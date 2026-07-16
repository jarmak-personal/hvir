import { describe, expect, it } from 'vitest'

import { TerminalSignalParser } from '../src/renderer/src/terminal/terminal-signals'

describe('terminal signal parser', () => {
  it('reports plain BEL without treating OSC terminators as bells', () => {
    const parser = new TerminalSignalParser()

    expect(parser.consume('\u0007').bells).toBe(1)
    expect(parser.consume('\u001b]0;Agent title\u0007')).toEqual({
      titles: ['Agent title'],
      oscillators: [],
      bells: 0,
    })
    expect(parser.consume('\u001b]2;Another title\u001b\\\u0007').bells).toBe(1)
  })

  it('recognizes OSC 9 and preserves split control sequences', () => {
    const parser = new TerminalSignalParser()

    expect(parser.consume('\u001b')).toEqual({
      titles: [],
      oscillators: [],
      bells: 0,
    })
    expect(parser.consume(']9;finished\u0007')).toEqual({
      titles: [],
      oscillators: [{ code: 9, data: 'finished' }],
      bells: 1,
    })
  })

  it('bounds malformed OSC carry without inventing attention', () => {
    const parser = new TerminalSignalParser()
    const malformed = `\u001b]9;${'x'.repeat(70 * 1024)}`

    expect(parser.consume(malformed).bells).toBe(0)
    expect(parser.consume('plain text').bells).toBe(0)
    expect(parser.consume(`still payload\u0007plain\u0007`).bells).toBe(1)
  })

  it('discards an oversized OSC through a split string terminator', () => {
    const parser = new TerminalSignalParser()
    const malformed = `\u001b]0;${'x'.repeat(70 * 1024)}`

    parser.consume(malformed)
    expect(parser.consume('payload\u001b').bells).toBe(0)
    expect(parser.consume('\\\u0007').bells).toBe(1)
  })
})
