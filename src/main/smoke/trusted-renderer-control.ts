import type { BrowserWindow } from 'electron'

/** Structured trusted DOM arguments and bounded CDP object lifetime at the immediate native edge. */
export async function trustedRendererControl(
  win: BrowserWindow,
  declaration: string,
  values: readonly (string | boolean)[],
  within: <T>(work: Promise<T>) => Promise<T>,
): Promise<boolean> {
  const debuggerPort = win.webContents.debugger,
    owned = !debuggerPort.isAttached()
  let objectId: string | undefined
  try {
    if (owned) debuggerPort.attach('1.3')
    const global = (await within(
      debuggerPort.sendCommand('Runtime.evaluate', { expression: 'globalThis' }),
    )) as { result?: { objectId?: string } }
    objectId = global.result?.objectId
    if (!objectId) throw new Error('Trusted control document is unavailable')
    const response = (await within(
      debuggerPort.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: declaration,
        arguments: values.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (response.exceptionDetails) throw new Error('Trusted control operation failed')
    return response.result?.value === true
  } finally {
    if (objectId && debuggerPort.isAttached())
      await within(debuggerPort.sendCommand('Runtime.releaseObject', { objectId }))
        .catch(() => {})
    if (owned && debuggerPort.isAttached()) debuggerPort.detach()
  }
}
