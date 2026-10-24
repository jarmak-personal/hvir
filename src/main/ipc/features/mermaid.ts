import type { IpcRegistrar } from '../authority-router'
import type { RendererResourceScopes } from '../../renderer-resource-scopes'
import type { MermaidRenderOwner } from '../../viewer/mermaid-render-owner'

/** Content-only computation grants no document or filesystem authority. */
export function registerMermaidIpc(
  ipc: IpcRegistrar,
  scopes: RendererResourceScopes,
  diagrams: MermaidRenderOwner,
): void {
  ipc.handle('mermaid:render', async (request, context) => {
    const owner = context.owner()
    scopes.register(
      owner,
      { lifetime: 'renderer', type: 'mermaid-render' },
      () => diagrams.cancel(owner),
      { duplicate: 'reuse' },
    )
    try {
      const svg = await diagrams.render(owner, request)
      scopes.assertCurrent(owner)
      return svg
    } catch {
      throw new Error(
        'Diagram preview unavailable: rendering failed, exceeded a limit, or was cancelled. Use Source to inspect the document.',
      )
    }
  })
  ipc.handleSend('mermaid:cancel', (request, context) => {
    if (request && typeof request.id === 'string')
      diagrams.cancel(context.owner(), request.id)
  })
}
