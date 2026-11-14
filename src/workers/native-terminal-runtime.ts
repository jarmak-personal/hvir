import { validNativeTerminalLinkQuery } from '../shared/native-terminal-link'
import { validNativeTerminalSelectionOperation } from '../shared/native-terminal-selection'
import {
  runNativeSelectionStep,
  type NativeSelectionEngineResult,
} from './native-terminal-selection'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import resource from '@hvir/native-terminal/resource'
import type { Frame, Status } from '@hvir/native-terminal/engine'
import {
  NATIVE_TERMINAL_LIMITS as limits,
  NativeTerminalAdmissionError,
  nativeTerminalCommandBytes,
  validNativeTerminalExtent,
  validNativeTerminalKeyInput,
  type NativeTerminalCommand,
  type NativeTerminalHostMessage,
  type NativeTerminalWorkerOptions,
} from '../shared/native-terminal'
import { NativeTerminalJobs } from './native-terminal-jobs'
import {
  NativeTerminalInputResourceRefused,
  nativeTerminalInputCleanup,
  nativeTerminalInputResultCapacity,
  validNativeTerminalInput,
} from '../shared/native-terminal-input'
import { NativeTerminalInputResultCredits } from '../shared/native-terminal-input-admission'
import {
  validNativeTerminalExportMode,
  validNativeTerminalLinuxOptions,
} from '../shared/native-terminal-linux'
import {
  validNativeTerminalScale,
  NATIVE_TERMINAL_PRESENTATION,
} from '../shared/native-terminal-presentation'

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: NativeTerminalHostMessage): void
}
interface NativeResult extends NativeSelectionEngineResult {
  result: number
  id?: bigint
  status?: Status
  frame?: Frame
  data?: Uint8Array
  event?: unknown
  stride?: number
  info?: unknown
  link?: unknown
  unavailable?: number
  source?: 'user' | 'terminal-response'
  requestedMutation?: bigint
  captured?: boolean
  caret?: unknown
}
/** Process-local engine jobs and OS resources never cross the parent port. */
export function runNativeTerminalHost(
  port: ParentPort,
  options: NativeTerminalWorkerOptions,
): void {
  if (options.linux !== undefined && !validNativeTerminalLinuxOptions(options.linux))
    throw new Error('native-linux-config-invalid')
  const worker = new Worker(join(__dirname, 'native-terminal-engine.js'), {
    workerData: {
      library: options.library,
      ...(options.linux ? { linux: options.linux } : {}),
    },
  })
  const jobs = new NativeTerminalJobs()
  const requests = new Map<number, { cancelled: boolean }>()
  const frames = new Map<string, Frame>()
  const states = new Set<string>()
  let creating = 0
  const resultCredits = new NativeTerminalInputResultCredits()
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
            command.backingScale ?? 1,
          ]),
        )
      case 'key':
        return requireOk(
          await invoke(
            state,
            'key',
            [state, command.key, command.modifiers, command.action, command.text],
            nativeTerminalCommandBytes(command),
          ),
        ).data
      case 'input': {
        const result = await invoke(
          state,
          'input',
          [
            state,
            command.input,
            command.readOnly,
            command.keyEncodingFallback,
            command.selectionContext,
          ],
          nativeTerminalCommandBytes(command),
        )
        if (
          (result.result === 5 || result.result === 7) &&
          result.requestedMutation === 0n
        )
          throw new NativeTerminalInputResourceRefused()
        if (result.result === 6 && result.requestedMutation === 0n) {
          if (command.input.kind === 'caret') return { busy: true }
          // Native capacity was revalidated before any mutation/callback/fence.
          throw new NativeTerminalAdmissionError('native-input-capacity-changed')
        }
        const { data, ...metadata } = requireOk(result)
        return { ...(plain(metadata) as object), bytes: data }
      }
      case 'selection':
        return runNativeSelectionStep(
          command.operation,
          (operation) => invoke(state, 'selection', [state, operation]),
          cancelled,
        )
      case 'visibility':
        return requireOk(await invoke(state, 'visibility', [state, command.visible]))
      case 'presentation-mode':
        return requireOk(await invoke(state, 'presentation-mode', [state, command.mode]))
      case 'pixels': {
        const frame = frames.get(state)
        if (!frame || frame.lease.toString() !== command.lease)
          throw new Error('native-frame-lease-mismatch')
        const copied = requireOk(
          await invoke(state, 'pixels', [state, command.lease, frame.origin]),
        )
        if (
          !(copied.data instanceof Uint8Array) ||
          copied.stride !== frame.width * 4 ||
          copied.data.byteLength !== copied.stride * frame.height ||
          copied.data.byteLength > NATIVE_TERMINAL_PRESENTATION.maximumPixelBytes
        )
          throw new Error('native-pixel-bound')
        return { bytes: copied.data, stride: copied.stride }
      }
      case 'inspect':
      case 'producer-inspect':
        return plain(requireOk(await invoke(state, 'inspect', [state])).status)
      case 'renderer-info':
        return plain(requireOk(await invoke(state, 'renderer-info', [state])).info)
      case 'read':
      case 'drain':
        return requireOk(await invoke(state, command.kind, [state])).data
      case 'effects':
        return requireOk(await invoke(state, 'effects', [state]))
      case 'link': {
        const result = requireOk(await invoke(state, 'link', [state, command.query]))
        return result.unavailable
          ? { unavailable: result.unavailable }
          : plain(result.link ?? {})
      }
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
          screen: frame.screen,
          streamSequence: frame.streamSequence,
          snapshotMutation: frame.snapshotMutation,
          geometrySerial: frame.geometrySerial,
          kind: frame.kind,
          width: frame.width,
          height: frame.height,
          colorSpace: frame.colorSpace,
          origin: frame.origin,
          premultiplied: frame.premultiplied,
          resource: {
            fourcc: frame.fourcc,
            modifier: frame.modifier.toString(),
            planes: frame.planes.map(({ stride, offset, size }) => ({
              stride,
              offset,
              size,
            })),
          },
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
    const cleanup =
      value.command.kind === 'input' && nativeTerminalInputCleanup(value.command.input)
    let credit
    try {
      credit = resultCredits.reserve(
        value.command.kind === 'input'
          ? nativeTerminalInputResultCapacity(
              value.command.input,
              value.command.readOnly,
              (text) => Buffer.byteLength(text),
            )
          : 0,
        value.command.kind === 'input' && value.command.input.kind === 'paste',
        cleanup,
      )
    } catch (error) {
      port.postMessage({
        kind: 'result',
        epoch: options.epoch,
        id: value.id,
        ok: false,
        error:
          error instanceof NativeTerminalInputResourceRefused
            ? 'native-input-resource-refused'
            : 'native-admission-bound',
      })
      return
    }
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
              : error instanceof NativeTerminalInputResourceRefused
                ? 'native-input-resource-refused'
                : error instanceof NativeTerminalAdmissionError
                  ? 'native-admission-bound'
                  : 'native-operation-failed',
          }),
      )
      .finally(() => {
        requests.delete(value.id)
        credit.release()
      })
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
        (value.kind === 'create' || validNativeTerminalScale(value.backingScale ?? 1)) &&
        (value.kind === 'create' ||
          (Number.isSafeInteger(value.serial) && value.serial > 0))
      )
    case 'link':
      return validNativeTerminalLinkQuery(value.query)
    case 'selection':
      return validNativeTerminalSelectionOperation(value.operation)
    case 'key':
      return validNativeTerminalKeyInput(value)
    case 'input':
      return (
        validNativeTerminalInput(value.input) &&
        typeof value.readOnly === 'boolean' &&
        (value.keyEncodingFallback === undefined ||
          value.keyEncodingFallback === 'csi-u' ||
          value.keyEncodingFallback === 'modify-other-keys')
      )
    case 'visibility':
      return typeof value.visible === 'boolean'
    case 'presentation-mode':
      return validNativeTerminalExportMode(value.mode)
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
    case 'producer-inspect':
    case 'read':
    case 'drain':
    case 'effects':
    case 'renderer-info':
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
    case 'pixels':
      return typeof value.lease === 'string' && /^[1-9][0-9]{0,19}$/.test(value.lease)
    default:
      return false
  }
}
