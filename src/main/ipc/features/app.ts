import { app } from 'electron'

import { ECHO_REQUEST_TYPE, type AppInfo } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type AppIpcDeps = Pick<IpcDeps, 'echoWorker' | 'rendererReady' | 'updateAttention'>

export function registerAppIpc(ipc: IpcRegistrar, deps: AppIpcDeps): void {
  ipc.handle('app:info', (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
  }))

  ipc.handle('demo:echo', async (req) => {
    const result = await deps.echoWorker.request(ECHO_REQUEST_TYPE, { text: req.text })
    return { text: result.text, workerPid: result.workerPid }
  })

  ipc.handleSend('app:renderer-ready', (_payload, context) => {
    deps.rendererReady(context.owner())
  })
  ipc.handleSend('app:attention', ({ count }, context) => {
    const safeCount = Number.isSafeInteger(count) ? Math.max(0, Math.min(99, count)) : 0
    deps.updateAttention(context.owner(), safeCount)
  })
}
