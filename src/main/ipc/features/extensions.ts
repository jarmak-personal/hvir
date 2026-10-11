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
  ipc.handle(
    'extensions:foreground',
    (_req, context) => extensions?.surface.foreground(context.owner()) ?? false,
  )
  ipc.handle('extensions:delivery-recovery', (_req, context) => {
    context.owner()
    return extensions?.deliveries?.recoveryStatus() ?? []
  })
  ipc.handle('extensions:delivery-resolve', (req, context) => {
    const owner = context.owner()
    if (
      !['inspect', 'keep', 'reconcile', 'cleanup'].includes(req.kind) ||
      typeof req.id !== 'string' ||
      req.id.length > 80
    )
      throw new Error('Invalid exact delivery recovery request')
    return (
      extensions?.deliveries?.trustedRecovery(
        req.kind,
        req.id,
        () => extensions.guests?.assertOwner(owner),
        new AbortController().signal,
      ) ?? unavailable()
    )
  })
  ipc.handle('extensions:source-settings', (req, context) => {
    context.owner()
    const activation = extensions?.activations?.active.get(req.installationId)
    if (!activation || !extensions?.sources) return unavailable()
    return {
      sources: extensions.sources.approvals.status(activation),
      workspaces: extensions.contexts?.workspaces() ?? [],
    }
  })
  ipc.handle(
    'extensions:source-proposals',
    (_req, context) => extensions?.sourceRequests?.snapshot(context.owner()) ?? [],
  )
  ipc.handle('extensions:source-decide', (req, context) =>
    extensions?.sourceRequests?.decide(context.owner(), req.id, req.accepted),
  )
  ipc.handle('extensions:source-prepare', (req, context) => {
    const owner = context.owner()
    return (
      extensions?.sources?.approvals.prepare(req, () =>
        extensions.guests?.assertOwner(owner),
      ) ?? unavailable()
    )
  })
  ipc.handle('extensions:source-approve', (req, context) => {
    context.owner()
    return extensions?.sources?.approvals.approve(req.token) ?? unavailable()
  })
  ipc.handle('extensions:source-revoke', (req, context) => {
    context.owner()
    return (
      extensions?.sources?.approvals.revoke(req.installationId, req.source) ??
      unavailable()
    )
  })
  ipc.handle('extensions:connector-settings', (req, context) => {
    context.owner()
    const activation = extensions?.activations?.active.get(req.installationId)
    const approvals = extensions?.connectors?.approvals
    if (!activation || !approvals) return unavailable()
    return {
      hosts: approvals.hosts.listHosts(),
      connectors: approvals.status(activation),
    }
  })
  ipc.handle(
    'extensions:connection-proposals',
    (_req, context) => extensions?.connections?.snapshot(context.owner()) ?? [],
  )
  ipc.handle(
    'extensions:connection-decide',
    (req, context) =>
      extensions?.connections?.decide(context.owner(), req.id, req.accepted) ?? undefined,
  )
  ipc.handle('extensions:connector-connect', (req, context) => {
    const owner = context.owner()
    const activation = extensions?.activations?.active.get(req.installationId)
    if (!activation || !extensions?.connections) return unavailable()
    return extensions.connections.fromRenderer(
      owner,
      activation,
      () => {
        extensions.guests?.assertOwner(owner)
      },
      req.connector,
      req.request,
      () => extensions.surface.foreground(owner),
    )
  })
  ipc.handle('extensions:connector-prepare', (req, context) => {
    const owner = context.owner()
    return (
      extensions?.connectors?.approvals.prepare(req, () =>
        extensions.guests?.assertOwner(owner),
      ) ?? unavailable()
    )
  })
  ipc.handle('extensions:connector-approve', (req, context) => {
    context.owner()
    return extensions?.connectors?.approvals.approve(req.token) ?? unavailable()
  })
  ipc.handle('extensions:connector-revoke', (req, context) => {
    context.owner()
    return (
      extensions?.connectors?.approvals.revoke(req.installationId, req.connector) ??
      unavailable()
    )
  })
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
  ipc.handle(
    'extensions:add',
    (req, context) =>
      extensions?.additions?.add(context.owner(), req.request) ?? unavailable(),
  )
  ipc.handle('extensions:add-cancel-setup', (req, context) => {
    extensions?.additions?.cancelSetup(context.owner(), req.request)
  })
  ipc.handle('extensions:connection-cancel', (req, context) => {
    extensions?.connections?.cancelRenderer(context.owner(), req.request)
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
      extensions?.guests?.open(
        context.owner(),
        req.installationId,
        req.contributionId,
        undefined,
        { context: req.context },
      ) ?? unavailable(),
  )
  ipc.handle('extensions:contributions', (_req, context) => {
    context.owner()
    return extensions?.contributions?.snapshot() ?? []
  })
  ipc.handle('extensions:context', (_req, context) => ({
    surface: 'viewer' as const,
    visible: true,
    terminalIds: extensions?.contexts?.terminalIds(context.owner()) ?? {},
    sessions: extensions?.contexts?.sessions(context.owner()) ?? [],
  }))
  ipc.handle(
    'extensions:demand',
    (req, context) =>
      extensions?.contributions?.demand(context.owner(), req) ?? unavailable(),
  )
  ipc.handle('extensions:action', (req, context) => {
    const owner = context.owner()
    const activation = extensions?.activations?.active.get(req.installationId)
    const admitted = extensions?.contexts?.admit(owner, req.context)
    if (!activation || !admitted) return unavailable()
    const operation =
      extensions?.actions?.invoke(
        owner,
        activation,
        req.action,
        req.input ?? null,
        req.context,
        'human',
        'interactive',
        () => {
          if (
            extensions.activations?.active.get(req.installationId) !== activation ||
            !admitted.current()
          )
            throw new Error('Action context was revoked')
          extensions.guests?.assertOwner(owner)
        },
      ) ?? unavailable()
    return operation.then((value) => ({ value }))
  })
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
      req.refreshDemand,
      req.selected,
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
