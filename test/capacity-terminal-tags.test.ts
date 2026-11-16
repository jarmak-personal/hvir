import { describe, expect, it } from 'vitest'
import {
  capacityTerminalTagBits,
  capacityTerminalTaggedProducer,
  readCapacityTerminalTag,
  CAPACITY_TERMINAL_TAG_COLORS,
} from '../src/main/smoke/capacity-terminal-tags'
import { Script } from 'node:vm'

describe('synthetic terminal compositor tags', () => {
  it('decodes actual BGRA cell centers into row, sequence and applied PTY geometry', () => {
    const tag = { row: 3000, sequence: 510, columns: 97, rows: 20 }
    const bits = capacityTerminalTagBits(tag)
    const bytes = new Uint8Array(bits.length * 4 * 4)
    for (let cell = 0; cell < bits.length; cell++) {
      const [red, green, blue] = CAPACITY_TERMINAL_TAG_COLORS[bits[cell]!]!
      for (let pixel = 0; pixel < 4; pixel++)
        bytes.set([blue, green, red, 255], (cell * 4 + pixel) * 4)
    }
    expect(readCapacityTerminalTag(bytes, bits.length * 4, 1, 4, 2)).toEqual(tag)
    bytes[2] = 0
    bytes[6] = 0
    bytes[10] = 0
    bytes[14] = 0
    expect(readCapacityTerminalTag(bytes, bits.length * 4, 1, 4, 2)).toBeUndefined()
  })

  it('refuses invalid fields and incomplete/transparent image representations', () => {
    expect(() =>
      capacityTerminalTagBits({ row: 4096, sequence: 0, columns: 90, rows: 20 }),
    ).toThrow('capacity-terminal-tag-field')
    expect(readCapacityTerminalTag(new Uint8Array(), 46, 1, 1, 0)).toBeUndefined()
    expect(readCapacityTerminalTag(new Uint8Array(46 * 4), 46, 1, 1, 0)).toBeUndefined()
  })

  it('emits parseable real Node TTY fixture code with all 3000 initial rows', () => {
    const source = capacityTerminalTaggedProducer()
    expect(() => new Script(source)).not.toThrow()
    expect(source).toContain('i<3000')
    expect(source).toContain('input.setRawMode(true)')
  })
})
