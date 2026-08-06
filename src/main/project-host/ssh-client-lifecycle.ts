import type { Client, ConnectConfig } from 'ssh2'

export interface SshAuthenticationLifecycle {
  readonly completion: Promise<void>
  readonly cancel: (error: Error) => void
}

interface SshAuthenticationLifecycleOptions {
  readonly closedBeforeReadyError: string
  readonly releaseCredentials: () => void
  readonly onReady: () => void
  readonly onClose: (authenticated: boolean) => void
}

/** Owns one physical client's authentication settlement and safe credential boundary. */
export function startSshAuthentication(
  client: Client,
  config: ConnectConfig,
  options: SshAuthenticationLifecycleOptions,
): SshAuthenticationLifecycle {
  let ready = false
  let settled = false
  let closing = false
  let closeObserved = false
  let failure: Error | undefined
  let resolveCompletion: () => void
  let rejectCompletion: (error: Error) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const finish = (error?: Error): void => {
    if (settled) return
    settled = true
    if (error) rejectCompletion(error)
    else resolveCompletion()
  }
  const handleClose = (): void => {
    if (!closeObserved) {
      closeObserved = true
      options.onClose(ready)
    }
    if (ready) return
    options.releaseCredentials()
    finish(failure ?? new Error(options.closedBeforeReadyError))
  }
  const closeBeforeReady = (error: Error): void => {
    if (ready || settled) return
    failure ??= error
    if (closing) return
    closing = true
    void closeSshClient(client).then(handleClose)
  }
  client.once('ready', () => {
    if (failure) return
    ready = true
    options.onReady()
    options.releaseCredentials()
    finish()
  })
  client.on('error', (error) => {
    if (!ready && isRecoverableAuthenticationError(error)) return
    if (!ready) closeBeforeReady(error)
  })
  client.on('close', handleClose)
  try {
    client.connect(config)
  } catch (error) {
    closeBeforeReady(asError(error))
  }
  return { completion, cancel: closeBeforeReady }
}

export function closeSshClient(client: Client): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.removeListener('close', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        client.destroy()
      } finally {
        finish()
      }
    }, 1_000)
    client.once('close', finish)
    try {
      client.end()
    } catch {
      finish()
    }
  })
}

function isRecoverableAuthenticationError(error: Error): boolean {
  const level = (error as Error & { level?: string }).level
  return (
    level === 'agent' ||
    (level === 'client-authentication' && /\bsign(?:ing|ature)?\b/i.test(error.message))
  )
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
