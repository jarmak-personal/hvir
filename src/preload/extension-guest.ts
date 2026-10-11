/** hvir-owned isolated preload. No internal workbench bridge or arbitrary Electron API. */
import { contextBridge, ipcRenderer } from 'electron'
import { observeExtensionGuestVisibility } from './extension-guest-visibility'
import {
  EXTENSION_LIMITS,
  type ExtensionGuestBridge,
  type ExtensionReply,
} from '../shared/extensions/contract'

observeExtensionGuestVisibility(() => ipcRenderer.send('extension-guest:visible'))

// Remove the ordinary socket API before package scripts as defense in depth.
// Engine-enforced Connection-Allowlist blocks original constructors and fresh realms.
contextBridge.executeInMainWorld({
  func: () => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false,
      })
    }
  },
})

let messages = 0
let start = Date.now()
const callbacks = new Set<(message: ExtensionReply) => void>()
ipcRenderer.on('extension-guest:reply', (_event, message: ExtensionReply) => {
  for (const callback of callbacks) callback(message)
  if (message.kind === 'revoked') callbacks.clear()
})
const bridge: ExtensionGuestBridge = {
  send(message) {
    if (Date.now() - start >= 1000) {
      start = Date.now()
      messages = 0
    }
    if (++messages > EXTENSION_LIMITS.messagesPerSecond)
      throw new Error('Extension message rate limit exceeded')
    if (
      new TextEncoder().encode(JSON.stringify(message)).byteLength >
      EXTENSION_LIMITS.messageBytes
    )
      throw new Error('Extension message byte limit exceeded')
    ipcRenderer.send('extension-guest:message', message)
  },
  onMessage(callback) {
    if (callbacks.size >= 8) throw new Error('Extension subscription limit exceeded')
    callbacks.add(callback)
    return () => {
      callbacks.delete(callback)
    }
  },
}
contextBridge.exposeInMainWorld('hvirExtension', bridge)
