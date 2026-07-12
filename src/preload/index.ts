/**
 * Preload bridge — the ONLY module permitted to touch `ipcRenderer` (enforced
 * by lint). It exposes a single typed surface, `window.hvir`, validated against
 * the shared IPC contract. The renderer never sees `ipcRenderer` and can only
 * reach channels declared in `INVOKE_CHANNELS`.
 */

import { contextBridge, ipcRenderer } from 'electron'

import {
  INVOKE_CHANNELS,
  type HvirApi,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
} from '../shared'

const api: HvirApi = {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(
        new Error(`hvir: blocked non-contract IPC channel '${channel}'`),
      )
    }
    return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
  },
}

contextBridge.exposeInMainWorld('hvir', api)
