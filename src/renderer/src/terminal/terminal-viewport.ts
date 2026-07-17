interface ViewportTerminal {
  write(data: string): void
  getViewportY(): number
  getScrollbackLength(): number
  scrollToLine(line: number): void
}

/**
 * Write output without stealing a scrollback viewport from the user.
 *
 * ghostty-web 0.4 unconditionally scrolls to the live bottom from write() when
 * viewportY is non-zero. Restore the viewport synchronously, before the next
 * browser paint. Account for newly appended history so the same text remains
 * under the user's eyes rather than merely keeping the old distance from the
 * bottom.
 */
export function writePreservingViewport(terminal: ViewportTerminal, data: string): void {
  const viewportBefore = terminal.getViewportY()
  if (viewportBefore <= 0) {
    terminal.write(data)
    return
  }

  const scrollbackBefore = terminal.getScrollbackLength()
  terminal.write(data)
  const scrollbackGrowth = Math.max(0, terminal.getScrollbackLength() - scrollbackBefore)
  terminal.scrollToLine(viewportBefore + scrollbackGrowth)
}
