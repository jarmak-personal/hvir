import { CONNECTOR_LIMITS } from './connectors'
import { EXTENSION_LIMITS } from './contract'
import { DELIVERY_LIMITS } from './managed-delivery'
import { SOURCE_LIMITS } from './source-access'
/** Transport deadline follows the admitted capability's existing finite owning lifetime. */
export function extensionRequestDeadline(capability: string): number {
  if (capability === 'source.request')
    return SOURCE_LIMITS.decisionMs + EXTENSION_LIMITS.requestTimeoutMs
  if (capability.startsWith('connector.'))
    return CONNECTOR_LIMITS.timeoutMs + EXTENSION_LIMITS.requestTimeoutMs
  if (capability.startsWith('delivery.'))
    return DELIVERY_LIMITS.deadlineMs + EXTENSION_LIMITS.requestTimeoutMs
  if (capability === 'actions.invoke' || capability === 'terminal.start')
    return EXTENSION_LIMITS.actionMaximumMs
  return EXTENSION_LIMITS.requestTimeoutMs
}
