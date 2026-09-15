import type { ExecOptions } from './project-host'

/** Shared byte/record accounting for the host-owned buffered command boundary. */
export class BufferedExecOutput {
  private stdoutBytes = 0
  private stderrBytes = 0
  private nulRecords = 0

  constructor(
    private readonly options: ExecOptions,
    private readonly defaultMaxBytes: number,
  ) {}

  add(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (stream === 'stdout') {
      this.stdoutBytes += chunk.length
      if (this.options.maxStdoutNulRecords !== undefined) {
        for (const byte of chunk) if (byte === 0) this.nulRecords++
      }
    } else this.stderrBytes += chunk.length
  }

  get exceeded(): boolean {
    return (
      this.stdoutBytes + this.stderrBytes >
        (this.options.maxBuffer ?? this.defaultMaxBytes) ||
      this.stdoutBytes > (this.options.maxStdoutBytes ?? Infinity) ||
      this.stderrBytes > (this.options.maxStderrBytes ?? Infinity) ||
      (this.options.maxStdoutNulRecords !== undefined &&
        this.nulRecords >= this.options.maxStdoutNulRecords)
    )
  }
}
