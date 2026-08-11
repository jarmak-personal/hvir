import { clipboard } from 'electron'

import { MAX_CLIPBOARD_WRITE_TEXT } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps, SystemClipboardPort } from '../deps'

type ClipboardIpcDeps = Pick<IpcDeps, 'systemClipboard'>

const electronClipboard: SystemClipboardPort = {
  writeText: (text) => clipboard.writeText(text),
}

/**
 * The renderer decodes OSC 52 and decides whether a terminal may write the
 * clipboard. This registrar owns the effect, and re-checks shape and bounds
 * because IPC is its own boundary: the renderer's validation is not evidence
 * about what arrives on this channel.
 */
export function registerClipboardIpc(ipc: IpcRegistrar, deps: ClipboardIpcDeps): void {
  const target = deps.systemClipboard ?? electronClipboard
  ipc.handleSend('terminal:clipboard-write', (request, context) => {
    // Qualifies the sender against the current renderer owner, so a revoked
    // generation cannot reach the clipboard after its terminals are gone.
    context.owner()
    const { text } = request
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Invalid clipboard write')
    }
    if (text.length > MAX_CLIPBOARD_WRITE_TEXT) {
      throw new Error('Clipboard write exceeds the permitted size')
    }
    target.writeText(text)
  })
}
