export type ClientFrameDisposition = 'send' | 'drop' | 'disconnect'

/**
 * The broker never builds a second user-space send queue. A droppable PTY-data
 * frame is discarded before `socket.write` would exceed the cap; required
 * control frames fail the connection instead.
 */
export function clientFrameDisposition(
  writableBytes: number,
  frameBytes: number,
  limitBytes: number,
  droppable: boolean,
): ClientFrameDisposition {
  if (
    !Number.isSafeInteger(writableBytes) ||
    !Number.isSafeInteger(frameBytes) ||
    !Number.isSafeInteger(limitBytes) ||
    writableBytes < 0 ||
    frameBytes < 1 ||
    limitBytes < 1
  ) {
    throw new Error('Invalid client queue accounting')
  }
  if (frameBytes <= limitBytes && writableBytes + frameBytes <= limitBytes) {
    return 'send'
  }
  return droppable ? 'drop' : 'disconnect'
}
