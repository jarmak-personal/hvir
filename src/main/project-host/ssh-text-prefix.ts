import { isUtf8 } from 'node:buffer'

import {
  assertProjectHostTextPrefixByteLimit,
  boundTextWorkload,
  type TextWorkload,
} from '../../shared'
import { retainSftpErrorHandler } from './ssh-sftp-errors'

interface SshTextPrefixStream {
  readonly destroyed: boolean
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'error', listener: (reason: Error) => void): this
  once(event: 'end' | 'close', listener: () => void): this
  removeListener(event: 'data', listener: (chunk: Buffer) => void): this
  removeListener(event: 'end' | 'close', listener: () => void): this
}

interface SshTextPrefixSession {
  createReadStream(
    path: string,
    range: { readonly start: number; readonly end: number },
  ): SshTextPrefixStream
}

/** One bounded SFTP read whose promise settles on every stream lifecycle exit. */
export async function readSshTextPrefix(
  session: SshTextPrefixSession,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<TextWorkload> {
  assertProjectHostTextPrefixByteLimit(maxBytes)
  signal?.throwIfAborted()
  const value = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = session.createReadStream(path, { start: 0, end: maxBytes })
    let settled = false
    let ended = false
    const cleanup = (): void => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onClose)
      releaseErrors()
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (reason?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (reason) {
        if (!stream.destroyed) stream.destroy()
        reject(reason)
      } else {
        resolve(Buffer.concat(chunks))
      }
    }
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
    }
    const onError = (reason: Error): void => finish(reason)
    const onAbort = (): void =>
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Read aborted'))
    const onEnd = (): void => {
      ended = true
      finish()
    }
    const onClose = (): void => {
      if (!ended) finish(new Error('SSH text prefix read closed before completion'))
    }
    stream.on('data', onData)
    const releaseErrors = retainSftpErrorHandler(stream, onError)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  return {
    ...boundTextWorkload(value.toString('utf8'), maxBytes, value.byteLength <= maxBytes),
    validUtf8: isUtf8(value),
  }
}
