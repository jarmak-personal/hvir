import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'

import {
  PtyWriteIndeterminateError,
  type Disposer,
  type PtyExit,
  type PtyProcess,
} from './project-host'

export const SSH_PTY_WRITE_CONFIRM_TIMEOUT_MS = 5_000

type TransportFailureRegistration = (callback: () => void) => Disposer

export interface SshPtyProcess extends PtyProcess {
  bindTransportFailure(register: TransportFailureRegistration): void
}

/** Exit status closes input; the channel's drained close ends output ownership. */
export function createSshPtyProcess(channel: ClientChannel, pid: number): SshPtyProcess {
  const data = new Set<(value: string) => void>()
  const exits = new Set<(value: PtyExit) => void>()
  const inputClosures = new Set<() => void>()
  const decoder = new StringDecoder('utf8')
  let bound = false
  let reading = false
  let inputClosed = false
  let decoderEnded = false
  let exitCode: number | undefined
  let published: PtyExit | undefined
  let stopTransportFailure: Disposer = () => undefined
  const closeInput = (): void => {
    if (inputClosed) return
    inputClosed = true
    for (const callback of inputClosures) callback()
  }
  const output = (value: string): void => {
    if (value) for (const callback of data) callback(value)
  }
  const onData = (bytes: Buffer): void => output(decoder.write(bytes))
  const onEnd = (): void => {
    if (decoderEnded) return
    decoderEnded = true
    output(decoder.end())
  }
  const onExit = (code: number | null): void => {
    exitCode ??= code ?? 0
    closeInput()
  }
  const onClose = (): void => {
    if (published) return
    closeInput()
    onEnd()
    published = { exitCode: exitCode ?? 255, signal: undefined }
    channel.removeListener('data', onData)
    channel.removeListener('end', onEnd)
    channel.removeListener('exit', onExit)
    channel.removeListener('close', onClose)
    void stopTransportFailure()
    for (const callback of exits) callback(published)
  }
  channel.on('end', onEnd)
  channel.on('exit', onExit)
  channel.on('close', onClose)
  const process: SshPtyProcess = {
    pid,
    bindTransportFailure(register) {
      if (bound) throw new Error('SSH PTY transport failure already bound')
      bound = true
      if (published) return
      const stop = register(() => {
        // ssh2 reports transport close before its channel cleanup pushes EOF.
        exitCode ??= 255
        closeInput()
      })
      // Registration may synchronously close a retired channel.
      if (published) void stop()
      else stopTransportFailure = stop
    },
    get inputClosed() {
      return inputClosed
    },
    onData(callback) {
      const stop = subscribe(data, callback)
      if (!reading && !published) {
        reading = true
        channel.on('data', onData)
      }
      return stop
    },
    onExit(callback) {
      if (published) {
        callback(published)
        return () => undefined
      }
      return subscribe(exits, callback)
    },
    write(value) {
      if (inputClosed) throw new Error('SSH PTY input already closed')
      channel.write(typeof value === 'string' ? value : Buffer.from(value))
    },
    writeConfirmed(value) {
      if (inputClosed) return Promise.reject(new Error('SSH PTY already exited'))
      return new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let stopInput: Disposer = () => undefined
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          timer = undefined
          void stopInput()
          if (error) reject(error)
          else resolve()
        }
        stopInput = subscribe(inputClosures, () =>
          finish(
            new PtyWriteIndeterminateError('SSH PTY exited before write completion'),
          ),
        )
        timer = setTimeout(
          () =>
            finish(new PtyWriteIndeterminateError('SSH PTY write completion timed out')),
          SSH_PTY_WRITE_CONFIRM_TIMEOUT_MS,
        )
        try {
          channel.write(
            typeof value === 'string' ? value : Buffer.from(value),
            (error?: Error | null) => finish(error ?? undefined),
          )
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    pause: () => {
      channel.pause()
    },
    resume: () => {
      channel.resume()
    },
    resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
    kill() {
      closeInput()
      channel.close()
    },
  }
  if (channel.closed || channel.destroyed) onClose()
  return process
}

function subscribe<T>(
  listeners: Set<(value: T) => void>,
  callback: (value: T) => void,
): Disposer {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}
