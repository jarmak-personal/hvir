/**
 * Main-side registration of the typed IPC contract. Every handler is typed
 * against `IpcInvokeMap` from the shared contract, so a channel's request and
 * response shapes are checked on both ends.
 */

import { app, ipcMain } from 'electron'

import {
  ECHO_REQUEST_TYPE,
  type AppInfo,
  type EchoResult,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
} from '../shared'
import type { WorkerClient } from './worker-host'

type Handler<C extends IpcInvokeChannel> = (
  req: IpcRequest<C>,
) => IpcResponse<C> | Promise<IpcResponse<C>>

function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (_event, req: IpcRequest<C>) => handler(req))
}

export interface IpcDeps {
  readonly echoWorker: WorkerClient
}

export function registerIpcHandlers(deps: IpcDeps): void {
  handle('app:info', (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
  }))

  handle('demo:echo', async (req) => {
    const result = await deps.echoWorker.request<EchoResult>(ECHO_REQUEST_TYPE, {
      text: req.text,
    })
    return { text: result.text, workerPid: result.workerPid }
  })
}
