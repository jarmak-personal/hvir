import type { Disposer, PtyExit, PtyProcess } from '../project-host/project-host'

export interface PendingPtyExit {
  readonly promise: Promise<void>
  readonly dispose: Disposer
}

/** Monotonic resource state, revoked by the facade or an actual process exit. */
export class PtySessionLifetime {
  private exited = false
  private revoked = false
  private launchDiagnostic = ''
  private readonly disposers: Disposer[] = []

  constructor(private readonly pty: PtyProcess) {}

  get current(): boolean {
    return !this.exited && !this.revoked
  }

  own(dispose: Disposer): void {
    if (!this.current) void dispose()
    else this.disposers.push(dispose)
  }

  recordLaunchOutput(data: string): void {
    if (this.launchDiagnostic.length < 4_096) {
      this.launchDiagnostic = `${this.launchDiagnostic}${data}`.slice(0, 4_096)
    }
  }

  start(
    onExit: (exit: PtyExit, launchOutput: string) => void,
    afterExit: () => void,
  ): void {
    this.own(
      this.pty.onExit((exit) => {
        if (!this.current) return
        this.exited = true
        try {
          onExit(exit, this.launchDiagnostic)
        } finally {
          this.releaseChildren()
          afterExit()
        }
      }),
    )
  }

  write(data: string): void {
    this.pty.write(data)
  }
  writeConfirmed(data: string): Promise<void> {
    return this.pty.writeConfirmed(data)
  }
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows)
  }
  kill(signal?: string): void {
    this.pty.kill(signal)
  }

  terminate(waitForExit = false): PendingPtyExit | undefined {
    if (this.revoked) return
    this.revoked = true
    this.releaseChildren()
    let pending: PendingPtyExit | undefined
    if (waitForExit && !this.exited) {
      let disposeExit: Disposer = () => undefined
      const promise = new Promise<void>((resolve) => {
        disposeExit = this.pty.onExit(() => resolve())
      })
      pending = { promise, dispose: () => disposeExit() }
    }
    if (!this.exited) this.pty.kill()
    return pending
  }

  private releaseChildren(): void {
    for (const dispose of this.disposers.splice(0).reverse()) void dispose()
  }
}
