import type { PtyExit, PtyProcess } from '../project-host/project-host'
import type { PtyPreparedTerminal } from './pty-contract'

const SESSION_BYTES = 128 * 1024
const TOTAL_BYTES = 1024 * 1024

/** Credits include the physically active native call, even after logical removal. */
export class PtyTerminalOutputBudget {
  private bytes = 0
  get queuedBytes(): number {
    return this.bytes
  }
  reserve(bytes: number): boolean {
    if (bytes > TOTAL_BYTES - this.bytes) return false
    this.bytes += bytes
    return true
  }
  release(bytes: number): void {
    this.bytes -= bytes
  }
}

/** One source-owned ingress: active output plus one coalesced pending text batch.
 * Renderer replay/listeners never drive native parsing. Transport close must
 * preserve paused unread output before this owner settles its admitted tail. */
export class PtyTerminalOutput {
  private accepting = true
  private failed = false
  private disposing = false
  private paused = false
  private bytes = 0
  private text = ''
  private textBytes = 0
  private active?: Promise<void>
  private idle?: () => void
  private draining?: Promise<void>
  private disposed?: Promise<void>
  private ended?: Promise<void>
  constructor(
    private readonly source: Pick<PtyProcess, 'pause' | 'resume'>,
    private readonly terminal: PtyPreparedTerminal,
    private readonly budget: PtyTerminalOutputBudget,
  ) {
    if (!source.pause || !source.resume)
      throw new Error('pty-native-flow-control-unavailable')
  }
  get queuedBytes(): number {
    return this.bytes
  }
  output(decoded: string): void {
    if (!this.accepting || this.failed || !decoded) return
    const bytes = Buffer.byteLength(decoded, 'utf8')
    if (bytes > SESSION_BYTES - this.bytes || !this.budget.reserve(bytes)) {
      this.fail(new Error('pty-native-output-bound'))
      return
    }
    this.bytes += bytes
    this.text += decoded
    this.textBytes += bytes
    if (!this.paused) {
      this.paused = true
      try {
        this.source.pause!()
      } catch (error) {
        this.fail(error)
        return
      }
    }
    this.start()
  }
  exited(exit: PtyExit): Promise<void> {
    this.accepting = false
    this.ended ??= (async () => {
      await this.drain()
      if (!this.disposing) {
        try {
          await this.terminal.exited(exit)
        } catch (error) {
          this.fail(error)
        }
      }
    })()
    return this.ended
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.disposed
    this.disposing = true
    this.accepting = false
    this.clearPending()
    this.resume()
    this.disposed = (async () => {
      await this.drain()
      await this.terminal.dispose()
    })()
    return this.disposed
  }
  private start(): void {
    if (this.active || !this.text || this.failed || this.disposing) return
    const text = this.text,
      bytes = this.textBytes
    this.text = ''
    this.textBytes = 0
    this.active = Promise.resolve()
      .then(() => (this.disposing ? undefined : this.terminal.output(text)))
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.bytes -= bytes
        this.budget.release(bytes)
        this.active = undefined
        this.start()
        if (!this.active) {
          this.resume()
          if (!this.active && !this.text) {
            const settled = this.idle
            this.idle = undefined
            this.draining = undefined
            settled?.()
          }
        }
      })
  }
  private clearPending(): void {
    this.bytes -= this.textBytes
    this.budget.release(this.textBytes)
    this.text = ''
    this.textBytes = 0
  }
  private fail(error: unknown): void {
    if (this.failed || this.disposing) return
    this.failed = true
    this.accepting = false
    this.clearPending()
    try {
      this.terminal.failed(error)
    } catch {
      // A retired status observer cannot own source flow control.
    }
    this.resume()
  }
  private resume(): void {
    if (!this.paused) return
    this.paused = false
    try {
      this.source.resume!()
    } catch (error) {
      this.fail(error)
    }
  }
  private drain(): Promise<void> {
    if (!this.active && !this.text) return Promise.resolve()
    this.draining ??= new Promise<void>((resolve) => {
      this.idle = resolve
    })
    return this.draining
  }
}
