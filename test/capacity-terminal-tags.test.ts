import { describe, expect, it } from 'vitest'
import {
  capacityTerminalTagBits,
  capacityTerminalTagCellCount,
  capacityTerminalTagCells,
  capacityTerminalTaggedProducer,
  readCapacityTerminalTag,
  inspectCapacityTerminalTag,
  CAPACITY_TERMINAL_TAG_CELL_COUNT,
  CAPACITY_TERMINAL_TAG_COLORS,
} from '../src/main/smoke/capacity-terminal-tags'
import { Script } from 'node:vm'
import { createHash } from 'node:crypto'

describe('synthetic terminal compositor tags', () => {
  it('decodes actual BGRA cell centers into row, sequence and applied PTY geometry', () => {
    const tag = { row: 3000, sequence: 510, columns: 97, rows: 20 }
    const bits = capacityTerminalTagCells(tag)
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

  it('reports the exact late cell that cannot form the bounded witness', () => {
    const tag = { row: 3000, sequence: 0, columns: 102, rows: 24 }
    const bits = capacityTerminalTagCells(tag)
    const bytes = new Uint8Array(bits.length * 4 * 4)
    for (let cell = 0; cell < bits.length; cell++) {
      const [red, green, blue] = CAPACITY_TERMINAL_TAG_COLORS[bits[cell]!]!
      for (let pixel = 0; pixel < 4; pixel++)
        bytes.set([blue, green, red, 255], (cell * 4 + pixel) * 4)
    }
    expect(CAPACITY_TERMINAL_TAG_CELL_COUNT).toBe(27)
    expect(inspectCapacityTerminalTag(bytes, bits.length * 4, 1, 4, 2)).toEqual({ tag })
    for (let pixel = 0; pixel < 4; pixel++)
      bytes.set([96, 96, 96, 255], (26 * 4 + pixel) * 4)
    expect(inspectCapacityTerminalTag(bytes, bits.length * 4, 1, 4, 2)).toEqual({
      rejection: { reason: 'unmatched-color', index: 26 },
    })
    expect(readCapacityTerminalTag(bytes, bits.length * 4, 1, 4, 2)).toBeUndefined()
  })

  it('keeps every identity field in the fixed four-color v2 cell vector', () => {
    expect(
      capacityTerminalTagCells({ row: 3000, sequence: 10, columns: 102, rows: 24 }),
    ).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 2, 2, 0, 0, 0, 2, 1, 2, 1, 0, 2, 1, 0,
    ])
  })

  it('preserves exact canonical generated producer bytes and the default27-cell format', () => {
    expect(capacityTerminalTagCellCount()).toBe(27)
    expect(
      createHash('sha256').update(capacityTerminalTaggedProducer()).digest('hex'),
    ).toBe('d308e3789c22c31d6a151b63cd94e554a8023d0ed299caadf70938a66286c24a')
    expect(capacityTerminalTagCellCount('large-viewport')).toBe(35)
  })

  it.each([255, 256, 319, 65535])(
    'round trips all selected colored cells at wide geometry%s',
    (columns) => {
      const tag = { row: 4095, sequence: 1023, columns, rows: 65535 }
      const cells = capacityTerminalTagCells(tag, 'large-viewport')
      const bitmap = new Uint8Array(cells.length * 4)
      for (const [index, color] of cells.entries()) {
        const [red, green, blue] = CAPACITY_TERMINAL_TAG_COLORS[color]!
        bitmap.set([blue, green, red, 255], index * 4)
      }
      expect(
        readCapacityTerminalTag(bitmap, cells.length, 1, 1, 0.5, 'large-viewport'),
      ).toEqual(tag)
      bitmap.set([96, 96, 96, 255], 34 * 4)
      expect(
        inspectCapacityTerminalTag(bitmap, cells.length, 1, 1, 0.5, 'large-viewport'),
      ).toEqual({ rejection: { reason: 'unmatched-color', index: 34 } })
    },
  )

  it.each([255, 256, 319])(
    'executes the SAME generated producer against immediate TTY ports at columns%s',
    (columns) => {
      for (const profile of [undefined, 'large-viewport'] as const) {
        let input: ((chunk: Uint8Array) => void) | undefined
        const writes: string[] = []
        const ttyInput = {
          isTTY: true,
          setRawMode: () => undefined,
          resume: () => undefined,
          on: (_event: string, listener: (chunk: Uint8Array) => void) => {
            input = listener
          },
        }
        const ttyOutput = {
          isTTY: true,
          columns,
          rows: 95,
          write: (text: string) => {
            writes.push(text)
          },
          on: () => undefined,
        }
        new Script(capacityTerminalTaggedProducer(profile)).runInNewContext(
          {
            process: {
              stdin: ttyInput,
              stdout: ttyOutput,
              on: () => undefined,
              exit: () => {
                throw new Error('unexpected-exit')
              },
            },
          },
          { timeout: 1000 },
        )
        if (!input) throw new Error('fixture-input-not-installed')
        const emit = () => input!(Buffer.from('output:1\r'))
        if (profile === undefined && columns > 255) {
          expect(emit).toThrow('capacity-fixture-tag-overflow')
        } else {
          expect(emit).not.toThrow()
          expect(writes.join('')).toContain('output;1;1;' + columns + ';95')
          const cellWrites =
            writes.join('').split(String.fromCharCode(27) + '[48;2;').length - 1
          expect(cellWrites).toBe(capacityTerminalTagCellCount(profile))
        }
      }
    },
  )

  it('emits parseable real Node TTY fixture code with all 3000 initial rows', () => {
    const source = capacityTerminalTaggedProducer()
    expect(() => new Script(source)).not.toThrow()
    expect(source).toContain('i<3000')
    expect(source).toContain('input.setRawMode(true)')
  })
})
