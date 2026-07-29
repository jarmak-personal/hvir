import { app } from 'electron'

import { ECHO_REQUEST_TYPE, type AppInfo } from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type AppIpcDeps = Pick<
  IpcDeps,
  | 'echoWorker'
  | 'rendererReady'
  | 'updateAttention'
  | 'recordRenderContainment'
  | 'getWorkbenchHealth'
  | 'acknowledgeWorkbenchHealth'
  | 'diagnostics'
>

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
  ipc.handle('workbench-health:get', () => deps.getWorkbenchHealth())
  ipc.handle('workbench-health:acknowledge', ({ occurrenceId }, context) => {
    context.owner()
    return deps.acknowledgeWorkbenchHealth(occurrenceId)
  })
  ipc.handle('diagnostic-evidence:get', (_request, context) => {
    context.owner()
    return deps.diagnostics.evidence.evidenceState()
  })
  ipc.handle('diagnostic-evidence:delete', (_request, context) => {
    context.owner()
    return deps.diagnostics.evidence.deleteEvidence()
  })
  ipc.handleSend('app:renderer-ready', ({ ownerGeneration }, context) => {
    deps.rendererReady(context.owner(), ownerGeneration)
  })
  ipc.handleSend('diagnostics:render-containment', (batch, context) => {
    deps.recordRenderContainment(context.owner(), batch)
  })
  ipc.handleSend('app:attention', ({ count }, context) => {
    const safeCount = Number.isSafeInteger(count) ? Math.max(0, Math.min(99, count)) : 0
    deps.updateAttention(context.owner(), safeCount)
  })
}
