import type { ConnectorCaller } from './connector-execution'
import type { DeliveryCaller, ExtensionManagedDeliveryOwner } from './managed-delivery'
import type { AdmittedExtensionContext } from './context-owner'
import type {
  ExtensionInvocation,
  ExtensionManifest,
} from '../../shared/extensions/contract'

/** Native/guest transport shares caller identity; it supplies neither source nor domain approval. */
export async function requestGuestDelivery(
  capability: string,
  input: unknown,
  caller: ConnectorCaller,
  delivery: ExtensionManagedDeliveryOwner,
  context: AdmittedExtensionContext | undefined,
  authorize: DeliveryCaller['authorize'],
  human: boolean,
  manifest: ExtensionManifest,
  invocation?: ExtensionInvocation,
): Promise<unknown> {
  const action = invocation
    ? manifest.actions?.find((entry) => entry.id === invocation.action)
    : undefined
  const qualified: DeliveryCaller = {
    ...caller,
    admitted: context,
    authorize,
    mutationAllowed: human || (!!action && invocation?.authorization !== 'unapproved'),
    effects: human
      ? { delete: true, replace: true }
      : (action?.effects ?? { delete: false, replace: false }),
  }
  if (capability === 'delivery.capture') return delivery.capture(qualified, input)
  if (capability === 'delivery.manifest') return delivery.manifest(qualified, input)
  if (capability === 'delivery.preview') return delivery.preview(qualified, input)
  if (capability === 'delivery.apply') return delivery.apply(qualified, input)
  if (capability === 'delivery.status') return delivery.status(qualified, input)
  if (capability === 'delivery.domain') return delivery.domain(qualified, input)
  if (capability === 'delivery.reconcile') return delivery.reconcile(qualified, input)
  if (capability === 'delivery.cleanup') return delivery.reconcile(qualified, input, true)
  throw new Error('Unknown managed delivery capability')
}
