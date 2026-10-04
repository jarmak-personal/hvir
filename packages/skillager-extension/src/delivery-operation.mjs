/* global TextEncoder */
import { managementCli } from './management-cli.mjs'
import {
  absoluteLocalPath,
  acceptedSource,
  boundedManagementResult,
} from './management-contract.mjs'
import {
  deliveryDestination,
  exportedPayload,
  bindExportManifest,
  deliveryDomain,
  deliveryMetadata,
} from './delivery-contract.mjs'

async function pages(client, capability, input, bound, snapshot) {
  const entries = []
  let offset = 0
  for (;;) {
    const page = await client.request(capability, { ...input, offset })
    if (snapshot) {
      if (
        typeof page.revision !== 'string' ||
        (snapshot.revision && snapshot.revision !== page.revision)
      )
        throw new Error('Delivery evidence changed; observe complete records again')
      snapshot.revision = page.revision
    }
    if (!Array.isArray(page.entries) || entries.length + page.entries.length > bound)
      throw new Error('Complete delivery metadata exceeds its finite bound')
    entries.push(...page.entries)
    if (page.nextOffset === null) return entries
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('Delivery metadata page did not advance')
    offset = page.nextOffset
  }
}
export async function observeDeliveries(client, workspace) {
  const snapshot = await client.request('delivery.domain', {}),
    domain = deliveryDomain(snapshot.value),
    core = {},
    records = await pages(client, 'delivery.status', {}, 128, core),
    operations = await pages(client, 'delivery.status', { kind: 'operations' }, 64, core)
  return {
    records: records
      .filter(
        (record) =>
          record.workspace === workspace?.id &&
          record.root.hostId === workspace?.host &&
          record.root.path === workspace?.root?.path,
      )
      .map((record) => ({
        record,
        domain:
          domain.deliveries.find(
            (entry) =>
              entry.operation === record.operation &&
              entry.workspace === record.workspace &&
              entry.version === record.sourceVersion &&
              entry.target.hostId === record.target.hostId &&
              entry.target.path === record.target.path,
          ) ?? null,
      })),
    operations: operations.filter(
      (entry) =>
        entry.workspace === workspace?.id &&
        entry.root.hostId === workspace?.host &&
        entry.root.path === workspace?.root?.path,
    ),
    domain,
    allRecords: records,
    allOperations: operations,
    journalRevision: core.revision,
    allOperationIds: operations.map((entry) => entry.id),
    allRecordOperations: records.map((entry) => entry.operation),
    revision: snapshot.revision,
  }
}
export async function prepareDelivery(client, input, workspace, kind = 'add') {
  if (input.mode !== 'native')
    throw new Error(
      'SSH delivery supports Full only; Stub and Router require other workflows',
    )
  const target = deliveryDestination(workspace, input.skillId, input.agent)
  if (
    input.target &&
    (input.target.hostId !== target.hostId || input.target.path !== target.path)
  )
    throw new Error('The selected SSH target differs from its native agent directory')
  const observation = await observeDeliveries(client, workspace),
    existing =
      kind === 'add'
        ? undefined
        : observation.records.find(
            (entry) =>
              entry.record.id === input.record &&
              entry.record.target.hostId === target.hostId &&
              entry.record.target.path === target.path,
          )
  if (
    kind !== 'add' &&
    (!existing?.domain ||
      existing.domain.libraryId !== input.library.id ||
      existing.domain.skillId !== input.skillId ||
      existing.domain.agent !== input.agent ||
      existing.domain.policy !== 'managed')
  )
    throw new Error(
      'This exact delivery is pinned, unmanaged or unverifiable; preserve its files',
    )
  const io = managementCli(client)
  let capture,
    entries = [],
    selected,
    requirements = existing?.domain.requirements
  try {
    if (kind !== 'remove') {
      selected = acceptedSource(
        await io.run(['library', 'status', input.skillId, '--json']),
        input.library,
        input.skillId,
        input.hash,
      )
      requirements = deliveryMetadata(
        await io.run(['show', selected.id, '--full-json']),
        selected,
      )
      const destination = absoluteLocalPath(input.exportDirectory)
      capture = await io.run(
        [
          'export',
          selected.id,
          '--version',
          selected.hash,
          '--agent',
          input.agent,
          '--dest',
          destination.path,
          '--json',
        ],
        { kind: 'export', library: input.library, source: selected, destination },
        false,
        undefined,
        async (value, nativeReceipt) => {
          const files = exportedPayload(
              value,
              selected,
              input.library,
              input.agent,
              destination,
            ),
            captured = await client.request('delivery.capture', {
              source: 'delivery-source',
              path: destination,
              nativeReceipt,
            })
          capture = captured
          entries = await pages(
            client,
            'delivery.manifest',
            { receipt: captured.receipt },
            512,
          )
          bindExportManifest(files, entries)
          return captured
        },
      )
      io.verified()
      acceptedSource(
        await io.run(['library', 'status', selected.id, '--json']),
        input.library,
        selected.id,
        selected.hash,
      )
    }
    const preview = await client.request('delivery.preview', {
      destination: 'delivery-target',
      target,
      kind,
      ...(capture ? { capture: capture.receipt, sourceVersion: selected.hash } : {}),
      ...(existing ? { record: existing.record.id } : {}),
    })
    const metadata = {
      operation: preview.operation,
      workspace: workspace.id,
      libraryId: input.library.id,
      skillId: input.skillId,
      version: selected?.hash ?? existing.domain.version,
      agent: input.agent,
      target,
      requirements,
      policy: 'managed',
      state: 'pending',
    }
    const domain = compactDomain(observation)
    if (
      domain.deliveries.length >= 32 ||
      new TextEncoder().encode(
        JSON.stringify({ ...domain, deliveries: [...domain.deliveries, metadata] }),
      ).length > 4096
    )
      throw new Error(
        'Delivery domain capacity is full; resolve exact prior operations in Settings',
      )
    boundedManagementResult({ ...preview, reason: 'x'.repeat(240) })
    return {
      preview,
      metadata,
      domain,
      domainRevision: observation.revision,
      journalRevision: observation.journalRevision,
      entries,
      capture: capture?.receipt,
      input,
      workspace,
      kind,
      localExport: capture?.root,
      requirements,
      disclosure:
        'Full installs every displayed file and its mode. It does not execute the skill or prove a running agent loaded it. Updates and removals preserve displaced files outside active discovery; cleanup is a separate explicit Settings action. Local exports remain user files.',
    }
  } catch (error) {
    if (capture?.receipt)
      await client
        .request('delivery.manifest', { receipt: capture.receipt, release: true })
        .catch(() => {})
    throw error
  }
}
export async function applyPreparedDelivery(client, prepared) {
  const io = managementCli(client)
  let submitted = false
  try {
    if (prepared.kind !== 'remove')
      acceptedSource(
        await io.run(['library', 'status', prepared.input.skillId, '--json']),
        prepared.input.library,
        prepared.input.skillId,
        prepared.input.hash,
      )
    await client.request('delivery.domain', {
      write: true,
      expected: prepared.domainRevision,
      journalRevision: prepared.journalRevision,
      value: {
        ...prepared.domain,
        deliveries: [...prepared.domain.deliveries, prepared.metadata],
      },
    })
    submitted = true
    const result = await client.request('delivery.apply', {
      receipt: prepared.preview.receipt,
    })
    if (['completed', 'refused'].includes(result.outcome)) {
      try {
        await compactDeliveryMetadata(
          client,
          prepared.workspace,
          result.outcome === 'refused' ? prepared.metadata.operation : undefined,
        )
      } catch {
        result.metadata =
          'Tracking remains pending; observe again before another delivery'
      }
    }
    return boundedManagementResult({
      ...result,
      message:
        result.outcome === 'completed'
          ? `Full ${prepared.kind} completed for ${prepared.input.agent}. Files are user data; retained objects can be inspected in Settings.`
          : 'Delivery did not establish completion. Inspect its exact recorded objects in Settings; no mutation is replayed.',
    })
  } catch (error) {
    if (!submitted) throw error
    return {
      outcome: 'uncertain',
      operation: prepared.preview.operation,
      message:
        'Delivery request completion is unknown. Inspect this exact operation in Settings; no automatic replay is permitted.',
    }
  } finally {
    if (prepared.capture)
      await client
        .request('delivery.manifest', { receipt: prepared.capture, release: true })
        .catch(() => {})
  }
}
function compactDomain(observation, refusedOperation) {
  const referenced = new Set([
    ...observation.allRecordOperations,
    ...observation.allOperationIds,
    ...observation.allOperations.map((entry) => entry.previousOperation).filter(Boolean),
  ])
  const completed = [
    ...observation.allRecords,
    ...observation.allOperations
      .filter((entry) => entry.phase === 'completed')
      .map((entry) => ({ ...entry, operation: entry.id })),
  ]
  return {
    ...observation.domain,
    deliveries: observation.domain.deliveries
      .map((entry) => {
        const proven = completed.some(
          (record) =>
            record.operation === entry.operation &&
            record.workspace === entry.workspace &&
            record.sourceVersion === entry.version &&
            record.target.hostId === entry.target.hostId &&
            record.target.path === entry.target.path,
        )
        return proven ? { ...entry, state: 'settled' } : entry
      })
      .filter(
        (entry) =>
          referenced.has(entry.operation) ||
          (entry.state !== 'settled' && entry.operation !== refusedOperation),
      ),
  }
}
export async function compactDeliveryMetadata(client, workspace, refusedOperation) {
  const observation = await observeDeliveries(client, workspace)
  const next = compactDomain(observation, refusedOperation)
  if (JSON.stringify(next) !== JSON.stringify(observation.domain))
    await client.request('delivery.domain', {
      write: true,
      expected: observation.revision,
      journalRevision: observation.journalRevision,
      value: next,
    })
}
export async function forgetDeliveryMetadata(client, workspace, operation) {
  const observed = await observeDeliveries(client, workspace),
    entry = observed.domain.deliveries.find((entry) => entry.operation === operation)
  if (
    !entry ||
    entry.workspace !== workspace?.id ||
    entry.target.hostId !== workspace?.host ||
    !entry.target.path.startsWith(`${workspace.root.path.replace(/\/$/u, '')}/`) ||
    observed.allOperationIds.includes(operation) ||
    observed.allRecordOperations.includes(operation)
  )
    throw new Error(
      'Resolve this exact core delivery in Settings before ending its local domain tracking',
    )
  await client.request('delivery.domain', {
    write: true,
    expected: observed.revision,
    journalRevision: observed.journalRevision,
    value: {
      ...observed.domain,
      deliveries: observed.domain.deliveries.filter(
        (entry) => entry.operation !== operation,
      ),
    },
  })
  return {
    outcome: 'metadata-tracking-ended',
    operation,
    message:
      'Files remain in place. Only this resolved operation’s local Skillager metadata was removed; no authority was created.',
  }
}
export async function executeDelivery(client, invocation) {
  const workspace = invocation.context.workspace
  if (invocation.action === 'operation-state') {
    if (invocation.input.mode === 'delivery-forget')
      return forgetDeliveryMetadata(client, workspace, invocation.input.operationId)
    if (invocation.input.mode === 'delivery-reconcile')
      return client.request('delivery.reconcile', {
        operation: invocation.input.operationId,
        destination: 'delivery-target',
      })
    const observed = await observeDeliveries(client, workspace)
    return boundedManagementResult({
      entries: observed.records.slice(
        invocation.input.offset ?? 0,
        (invocation.input.offset ?? 0) + 2,
      ),
      operations: observed.operations.slice(
        invocation.input.offset ?? 0,
        (invocation.input.offset ?? 0) + 2,
      ),
      nextOffset:
        (invocation.input.offset ?? 0) + 2 <
        Math.max(observed.records.length, observed.operations.length)
          ? (invocation.input.offset ?? 0) + 2
          : null,
      presence:
        'Recorded deliveries; current remote state is verified only during exact preview or reconciliation',
    })
  }
  const input =
    invocation.action === 'change-exposure'
      ? {
          ...JSON.parse(invocation.input.request),
          library: invocation.input.library,
          agent: invocation.input.agent,
        }
      : invocation.input
  const kind =
    invocation.action === 'add-copy'
      ? 'add'
      : invocation.action === 'remove-copy'
        ? 'remove'
        : 'update'
  let prepared
  try {
    prepared = await prepareDelivery(client, input, workspace, kind)
    return await applyPreparedDelivery(client, prepared)
  } catch (error) {
    return {
      outcome: 'refused',
      message: error.message.slice(0, 240),
      ...(prepared ? { operation: prepared.preview.operation } : {}),
    }
  }
}
