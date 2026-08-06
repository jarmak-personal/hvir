import type { SFTPWrapper } from 'ssh2'

export function writeSftpFile(
  session: SFTPWrapper,
  path: string,
  data: Buffer,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  done: (reason: Error | null | undefined, value: void) => void,
): void {
  if (signal?.aborted) {
    done(abortError(), undefined)
    return
  }
  const stream = session.createWriteStream(path, mode === undefined ? {} : { mode })
  let settled = false
  const abort = () => {
    stream.destroy()
    finish(abortError())
  }
  const finish = (reason?: Error): void => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', abort)
    stream.removeListener('error', onError)
    stream.removeListener('finish', onFinish)
    stream.removeListener('close', onClose)
    done(reason, undefined)
  }
  const onError = (reason: Error) => finish(reason)
  const onFinish = () => finish()
  const onClose = () => finish(new Error('SSH file write closed before completion'))
  stream.once('error', onError)
  stream.once('finish', onFinish)
  stream.once('close', onClose)
  signal?.addEventListener('abort', abort, { once: true })
  stream.end(data)
}

export function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => finish(abortError())
    const finish = (reason?: unknown, value?: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (reason !== undefined) {
        reject(reason instanceof Error ? reason : new Error('SSH file operation failed'))
      } else resolve(value as T)
    }
    signal.addEventListener('abort', abort, { once: true })
    void task.then(
      (value) => finish(undefined, value),
      (reason: unknown) => finish(reason),
    )
  })
}

export function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}
