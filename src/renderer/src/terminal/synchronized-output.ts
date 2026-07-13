const SYNC_OUTPUT_BEGIN = '\u001b[?2026h'
const SYNC_OUTPUT_END = '\u001b[?2026l'

/**
 * DEC synchronized output lets a TUI update many cells without exposing its
 * intermediate states. ghostty-web processes a single `write` synchronously,
 * so handing it one complete frame makes that update atomic from the browser's
 * point of view.
 *
 * The PTY transport is allowed to split either marker across arbitrary chunks.
 * Keep a small prefix carry while idle, and hold an active frame until its end
 * marker arrives. The timeout and size cap prevent a malformed application from
 * leaving the terminal permanently frozen; forced frames get a synthetic end
 * marker so the emulator cannot remain in synchronized-output mode.
 */
export class SynchronizedOutputWriter {
  private activeFrame = ''
  private markerCarry = ''
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly writeOutput: (data: string) => void,
    private readonly redraw: () => void = () => undefined,
    private readonly maxFrameMs = 150,
    private readonly maxFrameLength = 2 * 1024 * 1024,
  ) {}

  write(chunk: string): void {
    if (!chunk) return
    let input = this.markerCarry + chunk
    this.markerCarry = ''

    while (input) {
      if (this.activeFrame) {
        const nestedBegin = input.lastIndexOf(SYNC_OUTPUT_BEGIN)
        this.activeFrame += input
        if (nestedBegin >= 0) this.armTimeout()

        const endAt = this.activeFrame.indexOf(SYNC_OUTPUT_END)
        if (endAt >= 0) {
          const frameEnd = endAt + SYNC_OUTPUT_END.length
          const trailing = this.activeFrame.slice(frameEnd)
          this.emit(this.activeFrame.slice(0, frameEnd), true)
          this.activeFrame = ''
          this.clearTimeout()
          input = trailing
          continue
        }

        if (this.activeFrame.length >= this.maxFrameLength) this.forceFrame()
        input = ''
        continue
      }

      const beginAt = input.indexOf(SYNC_OUTPUT_BEGIN)
      if (beginAt >= 0) {
        this.emit(input.slice(0, beginAt))
        this.activeFrame = SYNC_OUTPUT_BEGIN
        this.armTimeout()
        input = input.slice(beginAt + SYNC_OUTPUT_BEGIN.length)
        continue
      }

      const carryLength = markerPrefixSuffixLength(input)
      const outputEnd = input.length - carryLength
      this.emit(input.slice(0, outputEnd))
      this.markerCarry = input.slice(outputEnd)
      input = ''
    }
  }

  dispose(): void {
    this.clearTimeout()
    if (this.activeFrame) this.forceFrame()
    this.emit(this.markerCarry)
    this.markerCarry = ''
  }

  private forceFrame(): void {
    if (!this.activeFrame) return
    const frame = this.activeFrame
    this.activeFrame = ''
    this.clearTimeout()
    this.emit(frame + SYNC_OUTPUT_END, true)
  }

  private armTimeout(): void {
    this.clearTimeout()
    this.timeout = setTimeout(() => this.forceFrame(), this.maxFrameMs)
  }

  private clearTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = undefined
  }

  private emit(data: string, synchronized = false): void {
    if (!data) return
    this.writeOutput(data)
    if (synchronized) this.redraw()
  }
}

function markerPrefixSuffixLength(input: string): number {
  const max = Math.min(input.length, SYNC_OUTPUT_BEGIN.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (SYNC_OUTPUT_BEGIN.startsWith(input.slice(-length))) return length
  }
  return 0
}

export const synchronizedOutputMarkers = {
  begin: SYNC_OUTPUT_BEGIN,
  end: SYNC_OUTPUT_END,
} as const
