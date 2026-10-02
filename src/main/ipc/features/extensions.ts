import type { ExtensionApplicationRuntime } from '../../extensions/extension-application'
import type { IpcRegistrar } from '../authority-router'

/** Trusted controls and isolated guest messages use distinct caller admission. */
export function registerExtensionsIpc(
  ipc: IpcRegistrar,
  extensions?: ExtensionApplicationRuntime,
): void {
  const unavailable = (): never => {
    throw new Error('Extensions are unavailable')
  }
  ipc.handle('extensions:state', (_req, context) => {
    context.owner()
    return (
      extensions?.snapshot() ?? {
        writable: false,
        explanation: 'Extensions are unavailable',
        installations: [],
      }
    )
  })
  ipc.handle('extensions:discover', (_req, context) => {
    context.owner()
    return extensions?.activations?.discover() ?? unavailable()
  })
  ipc.handle('extensions:open-folder', (_req, context) => {
    context.owner()
    return extensions?.openFolder() ?? unavailable()
  })
  ipc.handle('extensions:enable', (req, context) => {
    context.owner()
    return extensions?.activations?.enable(req.source, req.revision) ?? unavailable()
  })
  ipc.handle('extensions:reload', (req, context) => {
    context.owner()
    return extensions?.activations?.reload(req.source, req.revision) ?? unavailable()
  })
  ipc.handle('extensions:remove', (req, context) => {
    context.owner()
    return (
      extensions?.activations?.remove(req.source, req.identity, req.forget) ??
      unavailable()
    )
  })
  ipc.handle('extensions:disable', (req, context) => {
    context.owner()
    return extensions?.activations?.disable(req.installationId) ?? unavailable()
  })
  ipc.handle(
    'extensions:open-view',
    (req, context) =>
      extensions?.guests?.open(context.owner(), req.installationId, req.contributionId) ??
      unavailable(),
  )
  ipc.handle('extensions:close-view', (req, context) => {
    return extensions?.guests?.close(context.owner(), req.viewId)
  })
  ipc.handle(
    'extensions:views',
    (_req, context) => extensions?.guests?.snapshot(context.owner()) ?? [],
  )
  ipc.handleSend('extensions:presentation', (req, context) => {
    extensions?.guests?.presentation(
      context.owner(),
      req.viewId,
      req.presentation,
      req.visible,
    )
  })
  // Only the exact main-frame guest WebContents identity, bound once during
  // attachment, supplies caller provenance. The message supplies no authority.
  ipc.handleSend('extension-guest:message', (value, context) => {
    extensions?.guests?.receive(context.sender.id, value)
  })
  ipc.handleSend('extension-guest:visible', (_value, context) => {
    extensions?.guests?.nativeVisibilityChanged(context.sender.id)
  })
}
