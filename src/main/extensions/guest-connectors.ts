import { extensionId, extensionObject } from '../../shared/extensions/validation'
import type { ExtensionGuestPorts } from './guest-capability-ports'
import { requestGuestDelivery } from './guest-delivery'
import type { ConnectorCaller } from './connector-execution'
import type { ExtensionContextOwner, AdmittedExtensionContext } from './context-owner'
import type { ExtensionGuestAuthority } from './guest-authority'
import type { ExtensionActivation } from './activation'
import type { ExtensionInvocation } from '../../shared/extensions/contract'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
interface ConnectorGuest {
  readonly authority: ExtensionGuestAuthority
  readonly activation: ExtensionActivation
  readonly view: ExtensionView
  readonly owner: RendererOwner
  readonly context?: AdmittedExtensionContext
  readonly visible: boolean
  readonly refreshDemand: boolean
  readonly readingOrigin: 'human' | 'agent' | 'action'
  readonly actions: ReadonlySet<string>
}
/** Connector provenance/demand adapts admitted guests to the finite execution owner. */
export async function requestGuestConnector(
  capability: string,
  input: unknown,
  record: ConnectorGuest,
  signal: AbortSignal,
  assertOrigin: () => void,
  contexts: ExtensionContextOwner,
  connectors: ExtensionGuestPorts['connectors'],
  connections: ExtensionGuestPorts['connections'],
  actions: ExtensionGuestPorts['actions'],
  connectorDemand: ExtensionGuestPorts['connectorDemand'],
  invocation: ExtensionInvocation | undefined,
  delivery: ExtensionGuestPorts['deliveries'],
  foreground: () => boolean,
): Promise<unknown> {
  if (capability === 'connector.connect') {
    if (
      record.view.role === 'updater' ||
      record.readingOrigin !== 'human' ||
      record.authority.restricted ||
      invocation ||
      record.actions.size ||
      !record.visible ||
      !foreground()
    )
      throw new Error('Program connection requires a visible ordinary human view')
    const connector = extensionId(extensionObject(input)['connector'])
    return connections.request(
      record.activation,
      record.owner,
      () => {
        assertOrigin()
        if (!record.visible || record.actions.size)
          throw new Error('Program connection demand ended')
      },
      signal,
      foreground,
      connector,
    )
  }
  const invocationAuthority = invocation
    ? actions.authority(record.view.id, invocation.id)
    : undefined
  const caller: ConnectorCaller = {
    authorizeHost: (host, workspace) => {
      if (invocation) {
        invocationAuthority?.assertCapability('connector.execute', host, workspace)
        record.authority
          .forAction(invocation.action)
          ?.assertCapability('connector.execute', host, workspace)
      } else record.authority.assertCapability('connector.execute', host, workspace)
    },
    activation: record.activation,
    view: record.view.id,
    signal,
    ...(invocation ? { action: invocation.id } : {}),
    current: assertOrigin,
    context: (workspace) => {
      if (
        !workspace ||
        (record.view.role !== 'updater' &&
          workspace !== record.context?.value.workspace?.id)
      )
        return undefined
      if (
        record.view.role === 'updater' &&
        !connectorDemand(record.activation.installationId, workspace)
      )
        return undefined
      return contexts.admit(record.owner, {
        surface: 'viewer',
        workspaceId: workspace,
      })
    },
    demand: (workspace) =>
      record.view.role === 'updater'
        ? record.visible &&
          connectorDemand(record.activation.installationId, workspace) === true
        : foreground() &&
          record.visible &&
          record.refreshDemand &&
          (!workspace || workspace === record.context?.value.workspace?.id),
  }
  if (capability.startsWith('delivery.')) {
    if (record.view.role === 'updater')
      throw new Error('Managed delivery is unavailable to this runtime')
    const authorize = (host: string, workspace?: string): void => {
      if (invocation) {
        invocationAuthority?.assertCapability(capability, host, workspace)
        record.authority
          .forAction(invocation.action)
          ?.assertCapability(capability, host, workspace)
      } else record.authority.assertCapability(capability, host, workspace)
    }
    return requestGuestDelivery(
      capability,
      input,
      caller,
      delivery,
      record.context,
      authorize,
      record.readingOrigin === 'human' && !record.authority.restricted && !invocation,
      record.activation.revision.manifest,
      invocation,
    )
  }
  if (capability === 'connector.status')
    return connectors.approvals.status(record.activation).map((entry) => ({
      connector: entry.connector,
      availability: entry.availability,
      ...(entry.host ? { host: entry.host } : {}),
      ...(entry.explanation ? { explanation: entry.explanation } : {}),
    }))
  if (capability === 'connector.output') return connectors.output(caller, input)
  return connectors.execute(caller, input)
}
