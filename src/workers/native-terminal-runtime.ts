import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import resource from '@hvir/native-terminal/resource'
import type { Frame, Status } from '@hvir/native-terminal/engine'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
  validNativeTerminalExtent,
  type NativeTerminalCommand,
  type NativeTerminalHostMessage,
  type NativeTerminalWorkerOptions,
} from '../shared/native-terminal'
import { NativeTerminalJobs } from './native-terminal-jobs'

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: NativeTerminalHostMessage): void
}
interface NativeResult {
  result: number
  id?: bigint
  status?: Status
  frame?: Frame
  data?: Uint8Array
  event?: unknown
}
/** Process-local engine jobs and OS resources never cross the parent port. */
export function runNativeTerminalHost(
  port: ParentPort,
  options: NativeTerminalWorkerOptions,
): void {
  const worker = new Worker(join(__dirname, 'native-terminal-engine.js'), {
    workerData: { library: options.library },
  })
  const jobs = new NativeTerminalJobs()
  const requests = new Map<number, { cancelled: boolean }>()
  const frames = new Map<string, Frame>()
  const states = new Set<string>()
  let creating = 0
  let nativeId = 0
  let current:
    | { id: number; resolve(value: NativeResult): void; reject(error: Error): void }
    | undefined
  let ready = false
  const fatal = (): void => {
    jobs.close(new Error('native-host-lost'))
    current?.reject(new Error('native-host-lost'))
    process.exit(1)
  }
  worker.on('error', fatal)
  worker.on('exit', fatal)
  worker.on(
    'message',
    (message: { kind?: string; id?: number; value?: NativeResult; fatal?: boolean }) => {
      if (message.kind === 'ready') {
        ready = true
        port.postMessage({ kind: 'ready', epoch: options.epoch, pid: process.pid })
        return
      }
      if (!current || message.id !== current.id || message.fatal || !message.value)
        return fatal()
      const completed = current
      current = undefined
      completed.resolve(message.value)
    },
  )
  const invoke = (
    state: string,
    operation: string,
    args: unknown[] = [],
    bytes = 0,
  ): Promise<NativeResult> =>
    jobs.enqueue(
      state,
      bytes,
      operation === 'feed' ? 'feed' : 'control',
      () =>
        new Promise((resolve, reject) => {
          if (current) {
            reject(new Error('native-owner-overlap'))
            return
          }
          current = { id: ++nativeId, resolve, reject }
          worker.postMessage({ id: nativeId, operation, args })
        }),
    )
  const requireOk = (value: NativeResult): NativeResult => {
    if (value.result) throw new Error(`native-result:${value.result}`)
    return value
  }
  const execute = async (
    command: NativeTerminalCommand,
    cancelled: () => boolean,
  ): Promise<unknown> => {
    const state = 'state' in command ? command.state : 'prepare'
    switch (command.kind) {
      case 'shutdown':
        if (states.size || frames.size || creating)
          throw new Error('native-host-not-idle')
        return requireOk(await invoke('host', 'close'))
      case 'create': {
        if (states.size + creating >= limits.states) throw new Error('native-state-bound')
        creating++
        let id: string | undefined
        try {
          const created = requireOk(
            await invoke(state, 'create', [command.width, command.height]),
          )
          if (!created.id) throw new Error('native-create-missing-id')
          id = created.id.toString()
          states.add(id)
          const deadline = Date.now() + 10000
          for (;;) {
            if (cancelled()) throw new Error('cancelled')
            const result = requireOk(await invoke(id, 'inspect', [id]))
            if (result.status?.failure) throw new Error('native-state-failed')
            if (result.status?.geometry.serial === 1n)
              return { state: id, status: plain(result.status) }
            if (Date.now() > deadline) throw new Error('native-prepare-timeout')
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
          }
        } catch (error) {
          if (id) {
            const destroyed = await invoke(id, 'destroy', [id])
            if (destroyed.result) {
              fatal()
              throw new Error('native-create-cleanup-failed', { cause: error })
            }
            states.delete(id)
          }
          throw error
        } finally {
          creating--
        }
      }
      case 'feed':
        return requireOk(
          await invoke(
            state,
            'feed',
            [state, command.sequence, command.bytes],
            command.bytes.byteLength,
          ),
        )
      case 'resize':
        return requireOk(
          await invoke(state, 'resize', [
            state,
            command.serial,
            command.width,
            command.height,
          ]),
        )
      case 'inspect':
        return plain(requireOk(await invoke(state, 'inspect', [state])).status)
      case 'read':
      case 'drain':
        return requireOk(await invoke(state, command.kind, [state])).data
      case 'event':
        return requireOk(await invoke(state, 'event', [state])).event
      case 'frame': {
        const taken = await invoke(state, 'frame', [state])
        if (taken.result) return { unavailable: taken.result }
        const frame = taken.frame
        if (!frame) throw new Error('native-frame-missing')
        frames.set(state, frame)
        if (cancelled()) {
          const released = await invoke(state, 'release', [state, frame.lease.toString()])
          if (released.result !== 0 && released.result !== 9) {
            fatal()
            throw new Error('native-frame-cleanup-failed')
          }
          frames.delete(state)
          throw new Error('cancelled')
        }
        return plain({
          lease: frame.lease,
          streamSequence: frame.streamSequence,
          geometrySerial: frame.geometrySerial,
          kind: frame.kind,
          width: frame.width,
          height: frame.height,
          colorSpace: frame.colorSpace,
          origin: frame.origin,
          premultiplied: frame.premultiplied,
        })
      }
      case 'transfer': {
        const frame = frames.get(state)
        if (!frame || frame.lease.toString() !== command.lease)
          throw new Error('native-frame-lease-mismatch')
        if (frame.kind !== 1 && frame.kind !== 2)
          throw new Error('native-hardware-resource-unavailable')
        await resource.sendFrame(
          options.resourceAddress,
          options.mainPid,
          command.ticket,
          {
            ...frame,
            surface: frame.surface ? Buffer.from(frame.surface) : undefined,
          },
        )
        return {}
      }
      case 'release': {
        const value = await invoke(state, 'release', [state, command.lease])
        // PRESENTATION means release succeeded; only this state's rearm failed.
        if (value.result !== 0 && value.result !== 9) requireOk(value)
        frames.delete(state)
        return value
      }
      case 'destroy': {
        const value = await invoke(state, 'destroy', [state])
        if (value.result === 0) {
          states.delete(state)
          frames.delete(state)
        }
        return value
      }
    }
  }
  port.on('message', ({ data }) => {
    if (!data || typeof data !== 'object') return
    const value = data as {
      kind: string
      epoch: string
      id: number
      command: NativeTerminalCommand
    }
    if (value.epoch !== options.epoch) return
    if (!Number.isSafeInteger(value.id) || value.id <= 0) return fatal()
    if (value.kind === 'cancel') {
      const request = requests.get(value.id)
      if (request) request.cancelled = true
      return
    }
    if (
      !ready ||
      value.kind !== 'request' ||
      requests.has(value.id) ||
      requests.size >= limits.commands
    )
      return fatal()
    if (!validCommand(value.command)) return fatal()
    const pending = { cancelled: false }
    requests.set(value.id, pending)
    void execute(value.command, () => pending.cancelled)
      .then(
        (result) =>
          port.postMessage({
            kind: 'result',
            epoch: options.epoch,
            id: value.id,
            ok: true,
            value: result,
          }),
        (error: unknown) =>
          port.postMessage({
            kind: 'result',
            epoch: options.epoch,
            id: value.id,
            ok: false,
            error: pending.cancelled
              ? 'cancelled'
              : error instanceof NativeTerminalAdmissionError
                ? 'native-admission-bound'
                : 'native-operation-failed',
          }),
      )
      .finally(() => requests.delete(value.id))
  })
}
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('native-sequence-bound')
    return Number(value)
  }
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === 'lease' && typeof v === 'bigint' ? v.toString() : plain(v),
      ]),
    )
  return value
}
function validCommand(value: NativeTerminalCommand): boolean {
  if (!value || typeof value !== 'object') return false
  if (
    value.kind !== 'create' &&
    value.kind !== 'shutdown' &&
    (!('state' in value) ||
      typeof value.state !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(value.state))
  )
    return false
  switch (value.kind) {
    case 'create':
    case 'resize':
      return (
        validNativeTerminalExtent(value.width, value.height) &&
        (value.kind === 'create' ||
          (Number.isSafeInteger(value.serial) && value.serial > 0))
      )
    case 'feed':
      return (
        value.bytes instanceof Uint8Array &&
        !(value.bytes.buffer instanceof SharedArrayBuffer) &&
        value.bytes.byteLength <= limits.feedChunkBytes &&
        Number.isSafeInteger(value.sequence) &&
        value.sequence > 0
      )
    case 'shutdown':
    case 'inspect':
    case 'read':
    case 'drain':
    case 'event':
    case 'destroy':
      return true
    case 'frame':
      return typeof value.ticket === 'string' && /^[\x21-\x7e]{1,128}$/.test(value.ticket)
    case 'transfer':
      return (
        typeof value.ticket === 'string' &&
        /^[\x21-\x7e]{1,128}$/.test(value.ticket) &&
        typeof value.lease === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(value.lease)
      )
    case 'release':
      return typeof value.lease === 'string' && /^[1-9][0-9]{0,19}$/.test(value.lease)
    default:
      return false
  }
}
