import type { WebContents } from 'electron'

// Preserve the existing public guest-inspection budget on both sides of executeJavaScript.
export const EXTENSION_GUEST_REQUEST_MS = 2000
export interface ExtensionGuestRequestResult {
  readonly ok?: boolean
  readonly error?: string
  readonly value?: unknown
}

/** The native caller must settle even when the guest cannot run its own timer. */
export async function requestExtensionGuest(
  guest: Pick<
    WebContents,
    'executeJavaScript' | 'isDestroyed' | 'once' | 'removeListener'
  >,
  id: string,
  capability: string,
): Promise<ExtensionGuestRequestResult> {
  const ended = () => new Error(`Public extension guest ended: ${id}`)
  if (guest.isDestroyed()) throw ended()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectLifetime: (error: Error) => void = () => undefined
  const lifetime = new Promise<never>((_resolve, reject) => {
    rejectLifetime = reject
  })
  const destroyed = (): void => rejectLifetime(ended())
  guest.once('destroyed', destroyed)
  try {
    if (guest.isDestroyed()) throw ended()
    timeout = setTimeout(
      () => rejectLifetime(new Error(`Public extension request timed out: ${id}`)),
      EXTENSION_GUEST_REQUEST_MS,
    )
    const result: unknown = await Promise.race([
      lifetime,
      guest.executeJavaScript(`new Promise((resolve, reject) => {
        let unsubscribe = () => {}, settled = false;
        const finish = (message, error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); unsubscribe();
          if (error) reject(error); else resolve(message);
        };
        const timer = setTimeout(() => finish(undefined, new Error('Public extension request timed out')), ${EXTENSION_GUEST_REQUEST_MS});
        try {
          unsubscribe = window.hvirExtension.onMessage(message => {
            if (message.kind === 'result' && message.id === ${JSON.stringify(id)}) finish(message);
          });
          if (settled) unsubscribe();
          else window.hvirExtension.send({kind:'request',id:${JSON.stringify(id)},capability:${JSON.stringify(capability)}});
        } catch (error) { finish(undefined, error); }
      })`),
    ])
    if (guest.isDestroyed()) throw ended()
    return result as ExtensionGuestRequestResult
  } finally {
    clearTimeout(timeout)
    guest.removeListener('destroyed', destroyed)
  }
}
