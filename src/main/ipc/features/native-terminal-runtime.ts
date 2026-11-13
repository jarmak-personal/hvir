import type { NativeTerminalApplication } from '../../terminal/native-terminal-application'
import type { IpcRegistrar } from '../authority-router'

export function registerNativeTerminalRuntimeIpc(
  ipc: IpcRegistrar,
  runtime?: NativeTerminalApplication,
): void {
  const requireRuntime = () => {
    if (!runtime) throw new Error('Native development terminal runtime is not selected')
    return runtime
  }
  ipc.handle('native-terminal:enabled', (_req, context) => {
    context.owner()
    return !!runtime
  })
  ipc.handle('native-terminal:attach', async ({ id }, context) => {
    const owner = context.owner()
    return { viewId: await requireRuntime().attach(id, owner, context.sender.mainFrame) }
  })
  ipc.handle('native-terminal:update', async (req, context) => {
    await requireRuntime().update(req.viewId, context.owner(), req)
  })
  ipc.handle('native-terminal:demand', (req, context) =>
    requireRuntime().demand(req.viewId, context.owner()),
  )
  ipc.handle('native-terminal:detach', (req, context) =>
    requireRuntime().detach(req.viewId, context.owner()),
  )
  ipc.handle('native-terminal:key', (req, context) =>
    requireRuntime().key(req.viewId, context.owner(), req),
  )
}
