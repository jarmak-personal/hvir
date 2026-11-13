import { randomUUID } from 'node:crypto'
import type { UtilityProcess } from 'electron'
import resource, { type Endpoint, type Receipt } from '@hvir/native-terminal/resource'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  type NativeTerminalCommand,
  type NativeTerminalHostMessage,
} from '../../shared/native-terminal'
import { spawnUtilityWorker, workerPath } from '../worker-host'
import type { NativeTerminalProcessPort } from './native-terminal-host'

interface Pending {
  readonly state: string
  readonly command: NativeTerminalCommand
  readonly bytes: number
  sent: boolean
  cancelled: boolean
  complete(value: unknown): void
  fail(error: Error): void
  cleanup(): void
}
/** One lazy utility generation. Failure is sticky; it never reconstructs lost state. */
export class NativeTerminalProcess implements NativeTerminalProcessPort {
  private generation = randomUUID()
  private child?: UtilityProcess
  private endpoint?: Endpoint
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private settled?: () => void
  private readonly waiting = new Set<{ state: string; bytes: number }>()
  private disposed = false
  private failure?: Error
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private bytes = 0
  private ready?: () => void
  private startupFailure?: (error: Error) => void
  constructor(
    private readonly library: string,
    private readonly outputDirectory?: string,
  ) {}
  get epoch(): string {
    return this.generation
  }
  get resourceAddress(): string {
    return process.platform === 'darwin'
      ? `org.hvir.native.${process.pid}.${this.epoch}`
      : `/tmp/hvir-native-${process.pid}-${this.epoch}.sock`
  }
  get available(): boolean {
    return !this.disposed && !this.failure
  }
  get pid(): number | undefined {
    return this.child?.pid
  }
  async receive(ticket: string): Promise<Receipt> {
    await this.start()
    if (!this.endpoint || !this.child?.pid || !this.available)
      throw new Error('native-host-lost')
    return resource.receive(this.endpoint, this.child.pid, ticket, 5000)
  }
  release(receipt: Receipt): void {
    resource.release(receipt)
  }
  request(command: NativeTerminalCommand, signal?: AbortSignal): Promise<unknown> {
    return this.submit(command, signal, false)
  }
  private submit(
    command: NativeTerminalCommand,
    signal: AbortSignal | undefined,
    cleanup: boolean,
  ): Promise<unknown> {
    if (!this.available)
      return Promise.reject(this.failure ?? new Error('native-host-closed'))
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
    const state =
      'state' in command
        ? command.state
        : command.kind === 'shutdown'
          ? 'host'
          : 'prepare'
    const byteCount = command.kind === 'feed' ? command.bytes.byteLength : 0
    const same = [...this.pending.values(), ...this.waiting].filter(
      (p) => p.state === state,
    )
    if (
      this.pending.size + this.waiting.size >=
        limits.commands -
          (this.stopping && command.kind !== 'shutdown' && !cleanup ? 1 : 0) ||
      same.length >= limits.commandsPerState ||
      this.bytes + byteCount > limits.queuedBytes ||
      same.reduce((n, p) => n + p.bytes, 0) + byteCount > limits.queuedBytesPerState
    )
      return Promise.reject(new Error('native-command-bound'))
    const snapshot =
      command.kind === 'feed'
        ? { ...command, bytes: command.bytes.slice() }
        : { ...command }
    if (this.stopping && command.kind !== 'shutdown' && !cleanup) {
      const reservation = { state, bytes: byteCount }
      this.waiting.add(reservation)
      this.bytes += byteCount
      const release = (): void => {
        if (this.waiting.delete(reservation)) this.bytes -= byteCount
      }
      return this.stopping
        .then(() => {
          release()
          return this.submit(snapshot, signal, false)
        })
        .finally(release)
    }
    const id = ++this.nextId
    if (!Number.isSafeInteger(id)) {
      this.lose(new Error('native-request-bound'))
      return Promise.reject(this.failure ?? new Error('native-request-bound'))
    }
    return new Promise((resolve, reject) => {
      let delivered = false
      const settle = (error?: Error, value?: unknown): void => {
        if (delivered) return
        delivered = true
        if (error) reject(error)
        else resolve(value)
      }
      const cancel = (): void => {
        const item = this.pending.get(id)
        if (!item || item.cancelled) return
        item.cancelled = true
        settle(new Error('cancelled'))
        if (item.sent) this.child?.postMessage({ kind: 'cancel', epoch: this.epoch, id })
        else this.finish(id)
      }
      const timer = setTimeout(
        () => this.lose(new Error('native-request-timeout')),
        limits.requestMs,
      )
      this.pending.set(id, {
        state,
        command: snapshot,
        bytes: byteCount,
        sent: false,
        cancelled: false,
        complete: (value) => settle(undefined, value),
        fail: (error) => settle(error),
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
        },
      })
      this.bytes += byteCount
      signal?.addEventListener('abort', cancel, { once: true })
      void this.start().then(
        () => {
          const item = this.pending.get(id)
          if (!item || item.cancelled) return
          if (!this.available || !this.child) {
            this.lose(new Error('native-host-lost'))
            return
          }
          item.sent = true
          this.child.postMessage({
            kind: 'request',
            epoch: this.epoch,
            id,
            command: snapshot,
          })
        },
        () => this.lose(new Error('native-initialization-failed')),
      )
    })
  }
  idle(): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.available || (!this.child && !this.starting)) return Promise.resolve()
    this.stopping = (async () => {
      await this.starting
      while (this.pending.size)
        await new Promise<void>((resolve) => {
          this.settled = resolve
        })
      await this.request({ kind: 'shutdown' })
      const child = this.child
      this.child = undefined
      child?.kill()
      const endpoint = this.endpoint
      this.endpoint = undefined
      if (endpoint) await resource.closeEndpoint(endpoint)
      this.starting = undefined
      this.startupFailure = undefined
      this.generation = randomUUID()
    })()
      .catch((error: unknown) => {
        this.lose(error instanceof Error ? error : new Error('native-idle-failed'))
      })
      .finally(() => {
        this.stopping = undefined
      })
    return this.stopping
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminate(new Error('native-host-closed'))
  }
  private start(): Promise<void> {
    if (!this.available)
      return Promise.reject(this.failure ?? new Error('native-host-closed'))
    if (this.starting) return this.starting
    this.starting = (async () => {
      const endpoint = await resource.createEndpoint(this.resourceAddress)
      if (!this.available) {
        await resource.closeEndpoint(endpoint)
        throw new Error('native-host-closed')
      }
      this.endpoint = endpoint
      await new Promise<void>((resolve, reject) => {
        this.ready = resolve
        this.startupFailure = reject
        const timer = setTimeout(
          () => this.lose(new Error('native-startup-timeout')),
          limits.requestMs,
        )
        const child = spawnUtilityWorker(
          workerPath('native-terminal-worker.js', this.outputDirectory),
          'hvir-native-terminal',
        )
        this.child = child
        child.once('spawn', () =>
          child.postMessage({
            epoch: this.epoch,
            library: this.library,
            resourceAddress: this.resourceAddress,
            mainPid: process.pid,
          }),
        )
        child.on('message', (message: unknown) => {
          if (this.child === child) this.message(message)
        })
        child.once('error', () => {
          clearTimeout(timer)
          if (this.child === child) this.lose(new Error('native-host-error'))
        })
        child.once('exit', () => {
          clearTimeout(timer)
          if (!this.disposed && this.child === child)
            this.lose(new Error('native-host-lost'))
        })
        const complete = this.ready
        this.ready = () => {
          clearTimeout(timer)
          complete?.()
        }
      })
    })()
    return this.starting
  }
  private message(value: unknown): void {
    if (!value || typeof value !== 'object')
      return this.lose(new Error('native-message-invalid'))
    const message = value as NativeTerminalHostMessage
    if (message.epoch !== this.epoch) return this.lose(new Error('native-epoch-invalid'))
    if (message.kind === 'ready') {
      if (message.pid !== this.child?.pid || !this.ready)
        return this.lose(new Error('native-ready-invalid'))
      this.ready()
      this.ready = undefined
      return
    }
    if (
      message.kind !== 'result' ||
      !Number.isSafeInteger(message.id) ||
      typeof message.ok !== 'boolean'
    )
      return this.lose(new Error('native-result-invalid'))
    const item = this.pending.get(message.id)
    if (!item) return this.lose(new Error('native-result-foreign'))
    if (
      item.cancelled &&
      message.ok &&
      (item.command.kind === 'create' || item.command.kind === 'frame')
    ) {
      const result = message.value as
        { state?: unknown; lease?: unknown; unavailable?: unknown } | undefined
      let cleanup: NativeTerminalCommand | undefined
      if (
        item.command.kind === 'create' &&
        typeof result?.state === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(result.state)
      )
        cleanup = { kind: 'destroy', state: result.state }
      else if (
        item.command.kind === 'frame' &&
        typeof result?.lease === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(result.lease)
      )
        cleanup = { kind: 'release', state: item.command.state, lease: result.lease }
      else if (item.command.kind === 'frame' && Number.isInteger(result?.unavailable)) {
        this.finish(message.id)
        return
      }
      // Free exactly this physical slot before admitting its uncancelled cleanup.
      this.finish(message.id)
      if (!cleanup) return this.lose(new Error('native-cancelled-acquisition-invalid'))
      void this.submit(cleanup, undefined, true).then(
        (value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('result' in value) ||
            (value.result !== 0 && !(cleanup.kind === 'release' && value.result === 9))
          )
            this.lose(new Error('native-cancelled-acquisition-cleanup-failed'))
        },
        () => this.lose(new Error('native-cancelled-acquisition-cleanup-failed')),
      )
      return
    }
    if (!item.cancelled) {
      if (message.ok) item.complete(message.value)
      else item.fail(new Error('native-operation-failed'))
    }
    this.finish(message.id)
  }
  private finish(id: number): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id)
    this.bytes -= item.bytes
    item.cleanup()
    if (!this.pending.size) {
      this.settled?.()
      this.settled = undefined
    }
  }
  private lose(error: Error): void {
    if (this.failure || this.disposed) return
    this.failure = error
    this.terminate(error)
  }
  private terminate(error: Error): void {
    this.startupFailure?.(error)
    this.startupFailure = undefined
    this.ready = undefined
    for (const [id, item] of this.pending) {
      item.fail(error)
      this.finish(id)
    }
    this.child?.kill()
    if (this.endpoint) {
      void resource.closeEndpoint(this.endpoint).catch(() => undefined)
      this.endpoint = undefined
    }
  }
}
