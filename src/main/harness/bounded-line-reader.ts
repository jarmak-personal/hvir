const DEFAULT_MAX_LINE_LENGTH = 256 * 1024

/** Reassembles streamed text while dropping records that exceed the configured bound. */
export class BoundedLineReader {
  private buffer = ''
  private discarding = false

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineLength = DEFAULT_MAX_LINE_LENGTH,
  ) {}

  push(chunk: string): void {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset)
      const end = newline === -1 ? chunk.length : newline
      const part = chunk.slice(offset, end)
      if (!this.discarding) {
        if (this.buffer.length + part.length <= this.maxLineLength) {
          this.buffer += part
        } else {
          this.buffer = ''
          this.discarding = true
        }
      }
      if (newline === -1) return
      if (!this.discarding && this.buffer) this.onLine(this.buffer)
      this.buffer = ''
      this.discarding = false
      offset = newline + 1
    }
  }
}
