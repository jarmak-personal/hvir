import { describe, expect, it } from 'vitest'

import { writePreservingViewport } from '../src/renderer/src/terminal/terminal-viewport'

class ForcedFollowTerminal {
  readonly writes: string[] = []
  readonly restoredLines: number[] = []

  constructor(
    private viewportY: number,
    private scrollbackLength: number,
    private readonly growth: number,
  ) {}

  write(data: string): void {
    this.writes.push(data)
    this.scrollbackLength += this.growth
    // Match ghostty-web 0.4: every write follows output when scrolled up.
    if (this.viewportY !== 0) this.viewportY = 0
  }

  getViewportY(): number {
    return this.viewportY
  }

  getScrollbackLength(): number {
    return this.scrollbackLength
  }

  scrollToLine(line: number): void {
    this.viewportY = Math.max(0, Math.min(this.scrollbackLength, line))
    this.restoredLines.push(this.viewportY)
  }
}

describe('terminal output viewport behavior', () => {
  it('continues following output when the user is already at the bottom', () => {
    const terminal = new ForcedFollowTerminal(0, 20, 2)

    writePreservingViewport(terminal, 'live output')

    expect(terminal.writes).toEqual(['live output'])
    expect(terminal.getViewportY()).toBe(0)
    expect(terminal.restoredLines).toEqual([])
  })

  it('keeps the same transcript text visible while new history arrives', () => {
    const terminal = new ForcedFollowTerminal(8.5, 20, 3)

    writePreservingViewport(terminal, 'agent output')

    expect(terminal.writes).toEqual(['agent output'])
    expect(terminal.getViewportY()).toBe(11.5)
    expect(terminal.restoredLines).toEqual([11.5])
  })

  it('restores a scrolled viewport when an in-place redraw adds no history', () => {
    const terminal = new ForcedFollowTerminal(6, 20, 0)

    writePreservingViewport(terminal, 'status redraw')

    expect(terminal.getViewportY()).toBe(6)
    expect(terminal.restoredLines).toEqual([6])
  })
})
