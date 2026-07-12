/**
 * Preload bridge — the ONLY module permitted to touch `ipcRenderer` (enforced
 * by lint). It exposes a single typed surface, `window.hvir`, validated against
 * the shared IPC contract. The renderer never sees `ipcRenderer` and can only
 * reach channels declared in `INVOKE_CHANNELS`.
 */

import { contextBridge, ipcRenderer } from 'electron'

import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type HvirApi,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcSendChannel,
  type IpcSendPayload,
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
  send<C extends IpcSendChannel>(channel: C, payload: IpcSendPayload<C>): void {
    if (!SEND_CHANNELS.includes(channel)) {
      throw new Error(`hvir: blocked non-contract IPC channel '${channel}'`)
    }
    ipcRenderer.send(channel, payload)
  },
  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ) {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`hvir: blocked non-contract IPC channel '${channel}'`)
    }
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      callback(payload as IpcEventPayload<E>)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.off(channel, listener)
    }
  },
}

contextBridge.exposeInMainWorld('hvir', api)
