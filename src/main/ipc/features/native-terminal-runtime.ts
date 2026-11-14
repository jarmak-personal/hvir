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
    const native = requireRuntime()
    const viewId = await native.attach(id, owner, context.sender.mainFrame)
    return {
      viewId,
      instanceId: native.sessions.get(id)?.session.instanceId,
      title: native.sessions.get(id)?.title,
      inputUnavailable: native.inputUnavailable(viewId, owner),
    }
  })
  ipc.handle('native-terminal:metadata', ({ id }, context) =>
    requireRuntime().metadata(id, context.owner()),
  )
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
  ipc.handle('native-terminal:input', (req, context) =>
    requireRuntime().input(req.viewId, context.owner(), req.input),
  )
  ipc.handle('native-terminal:selection', (req, context) =>
    requireRuntime().selection(req, context.owner()),
  )
  ipc.handle('native-terminal:selection-read', (req, context) =>
    requireRuntime().readSelection(req, context.owner()),
  )
  ipc.handle('native-terminal:link', (req, context) =>
    requireRuntime().captureLink(req, context.owner()),
  )
  ipc.handle('native-terminal:link-read', (req, context) =>
    requireRuntime().continueLink(req, context.owner()),
  )
  ipc.handleSend('native-terminal:selection-cancel', (req, context) =>
    requireRuntime().cancelSelection(req, context.owner()),
  )
}
