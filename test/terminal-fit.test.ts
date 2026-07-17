import { describe, expect, it } from 'vitest'

import { calculateTerminalFit } from '../src/renderer/src/terminal/terminal-fit'

describe('terminal fit geometry', () => {
  it('uses the complete content width without a phantom scrollbar reservation', () => {
    const dimensions = calculateTerminalFit({
      clientWidth: 124,
      clientHeight: 194,
      paddingTop: 3,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 2,
      cellWidth: 8,
      cellHeight: 17,
    })

    expect(dimensions).toEqual({ cols: 15, rows: 11 })
    expect(dimensions!.cols * 8).toBeLessThanOrEqual(124 - 2 - 2)
    expect(dimensions!.rows * 17).toBeLessThanOrEqual(194 - 3 - 3)
  })

  it('floors fractional cell counts so the final row and column stay visible', () => {
    expect(
      calculateTerminalFit({
        clientWidth: 103.5,
        clientHeight: 53.5,
        paddingTop: 3,
        paddingRight: 2,
        paddingBottom: 3,
        paddingLeft: 2,
        cellWidth: 9.5,
        cellHeight: 15.5,
      }),
    ).toEqual({ cols: 10, rows: 3 })
  })

  it('rejects missing geometry and retains the minimum usable VT size', () => {
    expect(
      calculateTerminalFit({
        clientWidth: 0,
        clientHeight: 100,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        cellWidth: 8,
        cellHeight: 16,
      }),
    ).toBeUndefined()
    expect(
      calculateTerminalFit({
        clientWidth: 10,
        clientHeight: 10,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        cellWidth: 8,
        cellHeight: 16,
      }),
    ).toEqual({ cols: 2, rows: 1 })
  })
})
