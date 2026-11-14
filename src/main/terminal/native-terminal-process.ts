import { randomUUID } from 'node:crypto'
import { validNativeTerminalSelectionCursor } from '../../shared/native-terminal-selection'
import type { UtilityProcess } from 'electron'
import resource, { type Endpoint, type Receipt } from '@hvir/native-terminal/resource'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
  nativeTerminalCommandBytes,
  type NativeTerminalCommand,
  type NativeTerminalHostMessage,
} from '../../shared/native-terminal'
import {
  validNativeTerminalLinuxOptions,
  type NativeTerminalLinuxOptions,
} from '../../shared/native-terminal-linux'
import { spawnUtilityWorker, workerPath } from '../worker-host'
import type { NativeTerminalProcessPort } from './native-terminal-host'
import {
  NativeTerminalInputPhysicalFailure,
  NativeTerminalInputResourceRefused,
  nativeTerminalInputCleanup,
  nativeTerminalInputResultCapacity,
} from '../../shared/native-terminal-input'
import {
  NativeTerminalInputResultCredits,
  type NativeTerminalInputResultCredit,
} from '../../shared/native-terminal-input-admission'

interface Pending {
  readonly state: string
  readonly command: NativeTerminalCommand
  readonly feed: boolean
  readonly bytes: number
  readonly inputCredit?: NativeTerminalInputResultCredit
  readonly physicalInput: boolean
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
  private readonly waiting = new Set<{
    state: string
    bytes: number
    feed: boolean
    inputCredit?: NativeTerminalInputResultCredit
  }>()
  private disposed = false
  private failure?: Error
  private exitedEpoch?: string
  private stoppingChild?: UtilityProcess
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private bytes = 0
  private readonly resultCredits = new NativeTerminalInputResultCredits()
  private ready?: () => void
  private startupFailure?: (error: Error) => void
  private readonly linux?: NativeTerminalLinuxOptions
  constructor(
    private readonly library: string,
    private readonly outputDirectory?: string,
    private readonly observe?: (event: {
      kind: 'spawn' | 'exit'
      epoch: string
      pid?: number
      code?: number
    }) => void,
    linux?: NativeTerminalLinuxOptions,
  ) {
    if (linux !== undefined && !validNativeTerminalLinuxOptions(linux))
      throw new Error('native-linux-config-invalid')
    this.linux =
      linux &&
      Object.freeze({
        presentationMode: linux.presentationMode,
        device: Object.freeze(
          linux.device.kind === 'default'
            ? { kind: 'default' as const }
            : {
                kind: 'drm-render-node' as const,
                node: Object.freeze({ ...linux.device.node }),
              },
        ),
      })
  }
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
  hasExited(epoch: string): boolean {
    return this.exitedEpoch === epoch
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
  request(
    command: NativeTerminalCommand,
    signal?: AbortSignal,
    eligible?: (signal: AbortSignal) => Promise<void>,
    physicalInput?: true,
  ): Promise<unknown> {
    return this.submit(
      command,
      signal,
      command.kind === 'release' ||
        command.kind === 'destroy' ||
        (command.kind === 'selection' &&
          (command.operation.kind === 'close' || command.operation.kind === 'finish')) ||
        (command.kind === 'visibility' && !command.visible) ||
        // NativeSessions serializes feed -> drain -> discard for each state.
        // Each physical credit is freed before the producer continuation runs;
        // waiting input therefore cannot consume its prerequisite progress slot.
        (command.kind === 'input' && nativeTerminalInputCleanup(command.input)) ||
        command.kind === 'producer-inspect' ||
        command.kind === 'drain' ||
        command.kind === 'effects',
      eligible,
      physicalInput === true && command.kind === 'input',
    )
  }
  private submit(
    command: NativeTerminalCommand,
    signal: AbortSignal | undefined,
    cleanup: boolean,
    eligible?: (signal: AbortSignal) => Promise<void>,
    physicalInput = false,
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
    const feed = command.kind === 'feed'
    const admitted = [...this.pending.values(), ...this.waiting]
    const controls = admitted.filter((item) => !item.feed)
    const byteCount = nativeTerminalCommandBytes(command)
    const capacity =
      command.kind === 'input'
        ? nativeTerminalInputResultCapacity(command.input, command.readOnly, (text) =>
            Buffer.byteLength(text),
          )
        : 0
    const same = admitted.filter((p) => p.state === state)
    if (
      this.pending.size + this.waiting.size >=
        limits.commands -
          (this.stopping && command.kind !== 'shutdown' && !cleanup ? 1 : 0) ||
      same.length >= limits.commandsPerState ||
      (!feed &&
        !cleanup &&
        command.kind !== 'shutdown' &&
        (controls.length >= limits.commands - limits.states - 1 ||
          same.filter((item) => !item.feed).length >= limits.commandsPerState - 2)) ||
      this.bytes + byteCount > limits.queuedBytes ||
      same.reduce((n, p) => n + p.bytes, 0) + byteCount > limits.queuedBytesPerState
    )
      return Promise.reject(new NativeTerminalAdmissionError('native-command-bound'))
    let inputCredit: NativeTerminalInputResultCredit | undefined
    try {
      if (command.kind === 'input')
        inputCredit = this.resultCredits.reserve(
          capacity,
          command.input.kind === 'paste',
          cleanup,
        )
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('native-input-admission-failed'),
      )
    }
    const snapshot =
      command.kind === 'feed'
        ? { ...command, bytes: command.bytes.slice() }
        : command.kind === 'input'
          ? { ...command, input: { ...command.input } }
          : { ...command }
    if (this.stopping && command.kind !== 'shutdown' && !cleanup) {
      const reservation = { state, bytes: byteCount, feed, inputCredit }
      this.waiting.add(reservation)
      this.bytes += byteCount
      const release = (): void => {
        if (this.waiting.delete(reservation)) {
          this.bytes -= byteCount
          inputCredit?.release()
        }
      }
      return this.stopping
        .then(() => {
          release()
          return this.submit(snapshot, signal, false, eligible, physicalInput)
        })
        .finally(release)
    }
    const id = ++this.nextId
    if (!Number.isSafeInteger(id)) {
      inputCredit?.release()
      this.lose(new Error('native-request-bound'))
      return Promise.reject(this.failure ?? new Error('native-request-bound'))
    }
    return new Promise((resolve, reject) => {
      const eligibility = new AbortController()
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
        if (!item.sent || !item.physicalInput) settle(new Error('cancelled'))
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
        feed,
        bytes: byteCount,
        inputCredit,
        physicalInput,
        sent: false,
        cancelled: false,
        complete: (value) => settle(undefined, value),
        fail: (error) => settle(error),
        cleanup: () => {
          eligibility.abort()
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
        },
      })
      this.bytes += byteCount
      signal?.addEventListener('abort', cancel, { once: true })
      void this.start().then(
        async () => {
          try {
            await eligible?.(eligibility.signal)
          } catch (error) {
            settle(error instanceof Error ? error : new Error('native-prefix-failed'))
            this.finish(id)
            return
          }
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
      if (!this.available) throw this.failure ?? new Error('native-host-closed')
      const child = this.child
      if (child && !this.hasExited(this.epoch)) {
        this.stoppingChild = child
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.off('exit', exited)
            reject(new Error('native-stop-timeout'))
          }, limits.requestMs)
          const exited = (): void => {
            clearTimeout(timer)
            resolve()
          }
          child.once('exit', exited)
          child.kill()
        })
      }
      this.child = undefined
      const endpoint = this.endpoint
      this.endpoint = undefined
      if (endpoint) await resource.closeEndpoint(endpoint)
      this.starting = undefined
      this.startupFailure = undefined
      this.generation = randomUUID()
    })()
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error('native-idle-failed')
        this.lose(failure)
        throw failure
      })
      .finally(() => {
        this.stopping = undefined
        this.stoppingChild = undefined
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
        const epoch = this.epoch
        const child = spawnUtilityWorker(
          workerPath('native-terminal-worker.js', this.outputDirectory),
          'hvir-native-terminal',
        )
        this.child = child
        let spawnedPid: number | undefined
        child.once('spawn', () => {
          spawnedPid = child.pid
          try {
            this.observe?.({ kind: 'spawn', epoch, pid: child.pid })
          } catch {
            /* Diagnostics never own native progress. */
          }
          child.postMessage({
            epoch: this.epoch,
            library: this.library,
            ...(this.linux ? { linux: this.linux } : {}),
            resourceAddress: this.resourceAddress,
            mainPid: process.pid,
          })
        })
        child.on('message', (message: unknown) => {
          if (this.child === child) this.message(message)
        })
        child.once('error', () => {
          clearTimeout(timer)
          if (this.child === child) this.lose(new Error('native-host-error'))
        })
        child.once('exit', (code) => {
          try {
            this.observe?.({ kind: 'exit', epoch, pid: spawnedPid, code })
          } catch {
            /* Diagnostics never own native progress. */
          }
          clearTimeout(timer)
          if (this.child === child) {
            this.exitedEpoch = epoch
            if (!this.disposed && this.stoppingChild !== child)
              this.lose(new Error('native-host-lost'))
            for (const [id, item] of this.pending) if (item.physicalInput) this.finish(id)
          }
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
      (item.cancelled &&
        message.ok &&
        (item.command.kind === 'create' || item.command.kind === 'frame')) ||
      (item.cancelled &&
        message.ok &&
        item.command.kind === 'selection' &&
        (item.command.operation.kind === 'begin' ||
          item.command.operation.kind === 'link-row-begin'))
    ) {
      const result = message.value as
        | { state?: unknown; lease?: unknown; cursor?: unknown; unavailable?: unknown }
        | undefined
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
      } else if (item.command.kind === 'selection') {
        if (validNativeTerminalSelectionCursor(result?.cursor))
          cleanup = {
            kind: 'selection',
            state: item.command.state,
            operation: { kind: 'close', cursor: result.cursor },
          }
        else if (result?.cursor === '0' || Number.isInteger(result?.unavailable)) {
          this.finish(message.id)
          return
        }
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
    if (item.cancelled && item.physicalInput) item.fail(new Error('cancelled'))
    if (!item.cancelled) {
      if (message.ok) item.complete(message.value)
      else
        item.fail(
          message.error === 'native-input-resource-refused'
            ? new NativeTerminalInputResourceRefused()
            : message.error === 'native-admission-bound'
              ? new NativeTerminalAdmissionError()
              : new Error('native-operation-failed'),
        )
    }
    this.finish(message.id)
  }
  private finish(id: number): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id)
    this.bytes -= item.bytes
    item.inputCredit?.release()
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
      if (item.physicalInput && item.sent && !this.hasExited(this.epoch)) {
        item.fail(new NativeTerminalInputPhysicalFailure(error.message))
        item.cleanup()
      } else {
        item.fail(error)
        this.finish(id)
      }
    }
    this.child?.kill()
    if (this.endpoint) {
      void resource.closeEndpoint(this.endpoint).catch(() => undefined)
      this.endpoint = undefined
    }
  }
}
