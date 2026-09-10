import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { DocumentReviewCondition } from './document-review-evidence.mts'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

/** One document-review observation at a time; polling and deadlines live in main. */
export class DocumentReviewDriver {
  readonly webContents: BrowserWindow['webContents']
  constructor(
    private readonly window: BrowserWindow,
    private readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
    private readonly timeoutMs = 10_000,
  ) {
    this.webContents = window.webContents
  }

  async run<T>(
    condition: DocumentReviewCondition,
    task: (signal: AbortSignal, deadline: number) => Promise<T>,
    observeRenderer = true,
  ): Promise<T> {
    this.checkpoint(`document-review: ${condition}`)
    const controller = new AbortController()
    const deadline = Date.now() + this.timeoutMs
    const abort = () =>
      controller.abort(new Error(`document review interrupted: ${condition}`))
    const gone = () =>
      controller.abort(new Error(`document review renderer exited: ${condition}`))
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`document review deadline exceeded: ${condition}`)),
      this.timeoutMs,
    )
    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
    for (const signal of signals) process.on(signal, abort)
    if (observeRenderer) {
      this.webContents.on('destroyed', gone)
      this.webContents.on('render-process-gone', gone)
    }
    let rejectAbort: () => void = () => undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error(`document review interrupted: ${condition}`),
        )
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try {
      if (observeRenderer && this.webContents.isDestroyed()) gone()
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return task(controller.signal, deadline)
        }),
        interrupted,
      ])
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', rejectAbort)
      controller.abort()
      for (const signal of signals) process.off(signal, abort)
      if (observeRenderer) {
        this.webContents.removeListener('destroyed', gone)
        this.webContents.removeListener('render-process-gone', gone)
      }
    }
  }

  evaluate<T>(condition: DocumentReviewCondition, script: string): Promise<T> {
    return this.run(condition, async (signal, deadline) => {
      for (;;) {
        signal.throwIfAborted()
        // A queued sample may execute after a stalled renderer resumes. Expired
        // samples perform no interaction. No renderer timer or listener is created.
        const result: unknown = await this.webContents.executeJavaScript(
          `Date.now() >= ${deadline} ? { pending: true } : (${script})`,
        )
        signal.throwIfAborted()
        if (!result || typeof result !== 'object') {
          throw new Error(`document review invalid renderer outcome: ${condition}`)
        }
        if ('ok' in result) {
          if (result.ok === true)
            return ('value' in result ? result.value : undefined) as T
          // Never propagate renderer-provided text to failure diagnostics.
          throw new Error(`document review condition failed: ${condition}`)
        }
        if (!('pending' in result) || result.pending !== true) {
          throw new Error(`document review invalid renderer outcome: ${condition}`)
        }
        await delay(25, undefined, { signal })
      }
    })
  }

  wait(
    condition: DocumentReviewCondition,
    test: () => boolean | Promise<boolean>,
    observeRenderer = true,
  ): Promise<void> {
    return this.run(
      condition,
      async (signal) => {
        for (;;) {
          signal.throwIfAborted()
          if (await test()) return
          await delay(25, undefined, { signal })
        }
      },
      observeRenderer,
    )
  }

  reload(): Promise<void> {
    return this.windowEvent('renderer-reload', 'did-finish-load', () =>
      this.window.reload(),
    )
  }

  destroy(): Promise<void> {
    return this.windowEvent('renderer-destroyed', 'destroyed', () =>
      this.window.destroy(),
    )
  }

  private async windowEvent(
    condition: DocumentReviewCondition,
    event: 'did-finish-load' | 'destroyed',
    trigger: () => void,
  ): Promise<void> {
    let ready = () => undefined as void
    try {
      await this.run(
        condition,
        () =>
          new Promise<void>((resolve) => {
            ready = resolve
            if (event === 'destroyed') this.webContents.once('destroyed', ready)
            else this.webContents.once('did-finish-load', ready)
            trigger()
          }),
        event !== 'destroyed',
      )
    } finally {
      if (event === 'destroyed') this.webContents.removeListener('destroyed', ready)
      else this.webContents.removeListener('did-finish-load', ready)
    }
  }
}
