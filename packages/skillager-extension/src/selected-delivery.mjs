import { deliveryDestination } from './delivery-contract.mjs'
import { observeDeliveries } from './delivery-operation.mjs'

/** Bind recorded delivery metadata to the selected canonical source and exact target. */
export async function selectedDelivery(client, selection) {
  const target = deliveryDestination(
    selection.workspace,
    selection.skillId,
    selection.agent,
  )
  const observed = await observeDeliveries(client, selection.workspace)
  const sameTarget = (value) =>
    value.target.hostId === target.hostId && value.target.path === target.path
  const records = observed.records.filter((entry) => sameTarget(entry.record))
  if (records.length > 1)
    throw new Error(
      'More than one delivery records this target. Inspect Delivery recovery in Settings.',
    )
  const existing = records[0]
  const matches = (entry) =>
    entry.libraryId === selection.library.id &&
    entry.skillId === selection.skillId &&
    entry.agent === selection.agent &&
    sameTarget(entry)
  if (
    existing &&
    (!existing.domain ||
      !matches(existing.domain) ||
      existing.domain.policy !== 'managed')
  )
    throw new Error(
      'This remote target has a different or protected source. Inspect Delivery recovery in Settings; its files stay protected.',
    )
  return {
    installed: existing
      ? {
          record: existing.record.id,
          target: existing.record.target.path,
          mode: 'native',
          status: 'recorded',
          sourceHash: existing.record.sourceVersion,
          domain: existing.domain,
        }
      : undefined,
    pending: observed.domain.deliveries.filter(
      (entry) =>
        entry.workspace === selection.workspace.id &&
        matches(entry) &&
        (entry.state === 'pending' ||
          observed.operations.some(
            (operation) =>
              operation.id === entry.operation && operation.phase !== 'completed',
          )),
    ),
  }
}
