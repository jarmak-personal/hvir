import type { ExtensionConnectorConnectionOwner } from './connector-connection'
import type { ExtensionSourceRequestOwner } from './source-request'
import type { ExtensionManagedDeliveryOwner } from './managed-delivery'
import type { ExtensionSourceReadingOwner } from './source-reading'
import type { ExtensionSourceReveal } from './source-reveal'
import type { ExtensionTerminalHandoff } from './terminal-handoff'
import type { ExtensionConnectorExecutionOwner } from './connector-execution'
import type { ExtensionActionOwner } from './action-owner'
import type { ExtensionPresentationState } from './presentation-state'
import type { ExtensionSessionContext } from '../../shared/extensions/contract'
import type { ExtensionView } from '../../shared/extensions/workbench'

/** Construction requires every capability and lifecycle owner; only terminal support varies. */
export interface ExtensionGuestPorts {
  readonly sources: Pick<
    ExtensionSourceReadingOwner,
    'select' | 'read' | 'render' | 'asset' | 'closeView' | 'revalidate'
  > & { readonly approvals: Pick<ExtensionSourceReadingOwner['approvals'], 'status'> }
  readonly sourceReveal: Pick<ExtensionSourceReveal, 'reveal'>
  readonly sourceRequests: Pick<ExtensionSourceRequestOwner, 'request' | 'revalidate'>
  readonly terminals?: Pick<ExtensionTerminalHandoff, 'start'>
  readonly deliveries: Pick<
    ExtensionManagedDeliveryOwner,
    'capture' | 'manifest' | 'preview' | 'apply' | 'status' | 'domain' | 'reconcile'
  >
  readonly connections: Pick<ExtensionConnectorConnectionOwner, 'request' | 'revalidate'>
  readonly connectors: Pick<
    ExtensionConnectorExecutionOwner,
    'execute' | 'output' | 'revalidate'
  > & {
    readonly approvals: Pick<ExtensionConnectorExecutionOwner['approvals'], 'status'>
  }
  readonly actions: Pick<
    ExtensionActionOwner,
    'authority' | 'provenance' | 'invoke' | 'result' | 'ready' | 'revokeView'
  >
  readonly presentationState: Pick<ExtensionPresentationState, 'values' | 'publish'>
  readonly connectorDemand: (
    this: void,
    installation: string,
    workspace?: string,
  ) => boolean
  readonly updaterFailed: (this: void, view: ExtensionView) => void
  readonly visibleContributionsChanged: (this: void) => void
  readonly updaterSessions: (
    this: void,
    installation: string,
  ) => readonly ExtensionSessionContext[]
}
