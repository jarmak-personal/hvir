import {
  LOCAL_HOST_ID,
  hostPathEquals,
  parseKeybindingOverrides,
  type HostPath,
} from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type WebPaneIpcDeps = Pick<
  IpcDeps,
  | 'getProject'
  | 'ptySupervisor'
  | 'rendererResources'
  | 'webPanes'
  | 'openExternal'
  | 'updateWebPaneBindings'
  | 'updateWebPaneFullPage'
>

export function registerWebPaneIpc(ipc: IpcRegistrar, deps: WebPaneIpcDeps): void {
  ipc.handle('web-pane:open', (req, context) => {
    const owner = context.owner()
    return operationResult(async () => {
      const active = deps.getProject()
      let root: HostPath
      let terminalId: string
      if (req.source === 'terminal') {
        root = ipc.authority.workspaceRoot(req.root)
        terminalId = req.terminalId
        if (!isTerminalId(terminalId)) throw new Error('Invalid source terminal')
        const terminal = deps.ptySupervisor.get(terminalId)
        if (
          !terminal ||
          terminal.ownerId !== owner.id ||
          terminal.ownerGeneration !== owner.generation ||
          terminal.hostId !== root.hostId ||
          !hostPathEquals(terminal.cwd, root)
        ) {
          throw new Error('Web pane source terminal is not live in this workspace')
        }
      } else {
        if (!isWebPaneId(req.paneId)) throw new Error('Invalid source web pane')
        const source = deps.webPanes.source(req.paneId, owner.id, owner.generation)
        if (!source) throw new Error('Source web pane is no longer live')
        root = ipc.authority.workspaceRoot(source.workspaceRoot)
        terminalId = source.terminalId
      }
      if (!hostPathEquals(root, active.root) || root.hostId !== active.host.hostId) {
        throw new Error('Web panes may be opened only from the active workspace')
      }
      deps.rendererResources.assertCurrent(owner)
      const route = await deps.webPanes.open({
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        sourceTerminalId: terminalId,
        workspaceRoot: root,
        host: active.host,
        url: req.url,
      })
      try {
        deps.rendererResources.register(
          owner,
          { lifetime: 'workspace', type: 'web-pane', root, id: route.paneId },
          () => deps.webPanes.close(route.paneId, owner.id, owner.generation),
          // Reopening the same workspace/origin intentionally returns the same route.
          { duplicate: 'reuse' },
        )
        return route
      } catch (error) {
        await deps.webPanes.close(route.paneId, owner.id, owner.generation)
        throw error
      }
    })
  })

  ipc.handle('web-pane:close', async (req, context) => {
    if (!isWebPaneId(req.paneId)) throw new Error('Invalid web pane id')
    const owner = context.owner()
    const disposed = await deps.rendererResources.disposeResource(
      owner,
      'web-pane',
      req.paneId,
    )
    if (!disposed) {
      await deps.webPanes.close(req.paneId, owner.id, owner.generation)
    }
  })

  ipc.handle('web-pane:open-external', async (req, context) => {
    if (!isWebPaneId(req.paneId)) throw new Error('Invalid web pane id')
    const owner = context.owner()
    const decision = deps.webPanes.navigationForPane(
      req.paneId,
      owner.id,
      req.url,
      owner.generation,
    )
    if (decision.kind !== 'external') throw new Error('External URL is not authorized')
    await deps.openExternal(decision.url)
  })

  ipc.handle('web-pane:open-browser', async (req, context) => {
    if (!isWebPaneId(req.paneId)) throw new Error('Invalid web pane id')
    const owner = context.owner()
    const source = deps.webPanes.source(req.paneId, owner.id, owner.generation)
    const decision = deps.webPanes.navigationForPane(
      req.paneId,
      owner.id,
      req.url,
      owner.generation,
    )
    if (!source || decision.kind !== 'allow') {
      throw new Error('Browser URL is not authorized by this web pane')
    }
    if (source.hostId !== LOCAL_HOST_ID) {
      throw new Error('Open in browser for SSH panes needs a compatibility route')
    }
    await deps.openExternal(decision.url)
  })

  ipc.handleSend('web-pane:reserved-bindings', (bindings, context) => {
    deps.updateWebPaneBindings(context.owner(), parseKeybindingOverrides(bindings))
  })
  ipc.handleSend('web-pane:full-page', ({ paneId }, context) => {
    const owner = context.owner()
    if (
      paneId !== undefined &&
      (!isWebPaneId(paneId) || !deps.webPanes.has(paneId, owner.id, owner.generation))
    ) {
      throw new Error('Invalid full-page web pane')
    }
    deps.updateWebPaneFullPage(owner, paneId)
  })
}

function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function isWebPaneId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
}
