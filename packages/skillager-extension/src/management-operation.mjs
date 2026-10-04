import { managementCli } from './management-cli.mjs'
import { initializeLibrary, synchronizeLibrary } from './management-library.mjs'
import { applyExposureChange } from './exposure-operation.mjs'
import { applyCopy } from './management-copy.mjs'
import { pendingManagement } from './management-pending.mjs'
import { reconciliationFacts } from './management-reconcile.mjs'
import { acceptReviewedVersion } from './review-acceptance.mjs'

const pending = pendingManagement()
function readableRecord(client, invocation, id) {
  if (!client.alive)
    throw new Error('Cached operation reports require a current admitted action')
  const record = pending.get(id),
    destination = record.operation.workspace,
    workspace = invocation.context.workspace
  if (record.operation.caller !== invocation.caller)
    throw new Error(
      'Operation records stay with their originally admitted caller class; no stored human decision is transferred',
    )
  if (
    destination &&
    (destination.id !== workspace?.id ||
      destination.host !== workspace?.host ||
      destination.root?.hostId !== workspace?.root?.hostId ||
      destination.root?.path !== workspace?.root?.path)
  )
    throw new Error(
      'This operation belongs to a different admitted host-qualified workspace',
    )
  return record
}

/** Admitted main provenance owns lifetime; workflows only consume public capabilities. */
export async function executeManagement(client, invocation) {
  if (invocation.action === 'operation-state' && invocation.input.mode === 'list')
    return {
      ids: pending.ids().filter((id) => {
        try {
          readableRecord(client, invocation, id)
          return true
        } catch {
          return false
        }
      }),
    }
  if (invocation.action === 'operation-state' && invocation.input.mode === 'report') {
    readableRecord(client, invocation, invocation.input.operationId)
    return pending.report(invocation.input.operationId, invocation.input.offset)
  }
  if (invocation.action === 'setup-project') {
    const workspace = invocation.context.workspace
    if (workspace?.host !== 'local' || workspace.root?.hostId !== 'local')
      throw new Error(
        'Choose an exact available local project/worktree before opening setup',
      )
    if (!['codex', 'claude'].includes(invocation.input.agent))
      throw new Error('Choose the displayed setup agent explicitly')
    return client.request('terminal.start', {
      connector: 'project-cli',
      workspace: workspace.id,
      args: ['setup', '--agent', invocation.input.agent],
    })
  }
  const workspace = invocation.context.workspace,
    project =
      ['add-copy', 'change-exposure', 'remove-copy'].includes(invocation.action) ||
      (invocation.action === 'sync-library' && workspace?.host === 'local') ||
      (invocation.action === 'operation-state' &&
        ['observe', 'acknowledge'].includes(invocation.input.mode) &&
        pending.get(invocation.input.operationId).operation.workspace)
  const io = managementCli(
    client,
    project ? invocation.context : undefined,
    (operation) => {
      if (operation) pending.assertAvailable(operation)
      pending.observe(
        invocation.id,
        operation
          ? {
              ...operation,
              caller: invocation.caller,
              authorization: invocation.authorization,
              ...(invocation.action === 'sync-library' && project ? { workspace } : {}),
            }
          : undefined,
      )
    },
    (output) => pending.retainOutput(invocation.id, output),
  )
  try {
    if (
      invocation.action === 'operation-state' &&
      ['observe', 'acknowledge'].includes(invocation.input.mode)
    ) {
      const record = readableRecord(client, invocation, invocation.input.operationId)
      const observation = await reconciliationFacts(
        io,
        record,
        invocation.context.workspace,
      )
      if (invocation.input.mode === 'acknowledge') {
        if (invocation.input.observation !== observation)
          throw new Error(
            'Safe-repeat observations changed; inspect the fresh complete observation before acknowledging.',
          )
        pending.release(record.id)
        return {
          outcome: 'reconciled',
          operationId: record.id,
          observation,
          message:
            'Current safe-repeat facts acknowledged. Original completion remains unknown; every new operation requires fresh public preflight.',
        }
      }
      return {
        outcome: 'observed',
        operationId: record.id,
        observation,
        message: 'Supported current facts observed. Original completion remains unknown.',
      }
    }
    if (invocation.action === 'initialize-library')
      return await initializeLibrary(io, invocation.input)
    if (invocation.action === 'accept-version')
      return await acceptReviewedVersion(io, invocation.input, invocation, (descriptor) =>
        pending.assertAvailable(descriptor),
      )
    if (invocation.action === 'sync-library') {
      const result = await synchronizeLibrary(
        io,
        invocation.input,
        invocation.caller !== 'agent',
      )
      return { ...result, ...(io.pending ? { operationId: invocation.id } : {}) }
    }
    if (invocation.action === 'change-exposure')
      return {
        ...(await applyExposureChange(io, invocation.input, workspace, (descriptor) =>
          pending.assertAvailable(descriptor),
        )),
        ...(io.pending ? { operationId: invocation.id } : {}),
      }
    if (['add-copy', 'remove-copy'].includes(invocation.action))
      return await applyCopy(
        io,
        invocation.action,
        invocation.input,
        invocation.context.workspace,
        (descriptor) => pending.assertAvailable(descriptor),
      )
    throw new Error('Unsupported local management action')
  } catch (error) {
    return {
      outcome: io.pending ? 'uncertain' : 'refused',
      action: invocation.action,
      message: error.message,
      ...(io.pending ? { operationId: invocation.id } : {}),
    }
  }
}
