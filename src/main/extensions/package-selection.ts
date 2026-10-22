import type { HostPath } from '../../shared/host-path'

/** Native selection stays outside the writer queue and cannot outlive its trusted intent. */
export async function selectExtensionPackage(
  pick: () => Promise<HostPath | undefined>,
  current: () => void,
  signal: AbortSignal,
): Promise<HostPath | undefined> {
  let abort!: () => void
  return Promise.race([
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      current()
      return pick()
    }),
    new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Extension package selection was revoked'),
        )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }),
  ]).finally(() => signal.removeEventListener('abort', abort))
}
