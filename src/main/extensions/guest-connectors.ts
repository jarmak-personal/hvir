import type {
  ExtensionConnectorExecutionOwner,
  ConnectorCaller,
} from './connector-execution'
import type { ExtensionActionOwner } from './action-owner'
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
}
/** Connector provenance/demand adapts admitted guests to the finite execution owner. */
export async function requestGuestConnector(
  capability: string,
  input: unknown,
  record: ConnectorGuest,
  signal: AbortSignal,
  assertOrigin: () => void,
  contexts: ExtensionContextOwner,
  connectors?: ExtensionConnectorExecutionOwner,
  actions?: ExtensionActionOwner,
  connectorDemand?: (installation: string, workspace?: string) => boolean,
  invocation?: ExtensionInvocation,
): Promise<unknown> {
  const invocationAuthority = invocation
    ? actions?.authority(record.view.id, invocation.id)
    : undefined
  if (!connectors) throw new Error('Connector execution is unavailable')
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
        !connectorDemand?.(record.activation.installationId, workspace)
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
          connectorDemand?.(record.activation.installationId, workspace) === true
        : record.visible &&
          record.refreshDemand &&
          (!workspace || workspace === record.context?.value.workspace?.id),
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
