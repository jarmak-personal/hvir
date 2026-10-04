import {
  prepareDelivery,
  applyPreparedDelivery,
  observeDeliveries,
  forgetDeliveryMetadata,
} from './delivery-operation.mjs'

/** Ordinary human review consumes the same public delivery contracts as admitted actions. */
export function bindDeliveryView(document, client, ports) {
  const element = (id) => document.getElementById(id)
  function selection() {
    return {
      agent: element('copy-agent').value,
      mode: element('copy-mode').value,
      exportDirectory: element('delivery-export').value.trim(),
      skillId: element('skill-id').value.trim(),
    }
  }
  async function prepare(kind, current, existing) {
    const chosen = selection(),
      source =
        kind === 'remove'
          ? { id: existing.domain.skillId, hash: existing.domain.version }
          : ports.source()
    if (!source || (kind !== 'remove' && source.id !== chosen.skillId))
      throw new Error('Select the current approved source version explicitly')
    const workspace = ports.context().workspace,
      input = {
        ...chosen,
        library: ports.library(),
        skillId: source.id,
        hash: source.hash,
        ...(existing
          ? { record: existing.record.id, target: existing.record.target }
          : {}),
      }
    if (
      existing &&
      (existing.domain.agent !== chosen.agent || existing.domain.skillId !== source.id)
    )
      throw new Error(
        'Choose the displayed agent and canonical source for this exact managed target',
      )
    const prepared = await prepareDelivery(client, input, workspace, kind),
      release = () =>
        prepared.capture
          ? client
              .request('delivery.manifest', { receipt: prepared.capture, release: true })
              .catch(() => {})
          : Promise.resolve()
    if (!current()) {
      await release()
      return
    }
    ports.review(
      `Review SSH Full ${kind}`,
      `Local library ${input.library.root.path} → ${workspace.host}: ${prepared.preview.target.path}. ${prepared.disclosure}`,
      {
        ...prepared.preview,
        files: prepared.entries,
        requirements: prepared.requirements,
        localExport: prepared.localExport,
      },
      {
        validateSelection: () => {
          if (
            JSON.stringify(selection()) !== JSON.stringify(chosen) ||
            (kind !== 'remove' && ports.source()?.hash !== source.hash) ||
            ports.library().id !== input.library.id ||
            ports.library().root.path !== input.library.root.path
          )
            throw new Error(
              'Source, agent or export selection changed; prepare and review again',
            )
        },
        release,
        perform: async () => {
          const result = await applyPreparedDelivery(client, prepared)
          ports.show(result)
          ports.say(result.message)
        },
      },
    )
  }
  ports.on('prepare-delivery', 'click', (_event, current) => prepare('add', current))
  ports.onSelection('delivery-export', 'input')
  ports.on('observe-deliveries', 'click', async (_event, current) => {
    const observation = await observeDeliveries(client, ports.context().workspace)
    if (!current()) return
    element('delivery-list').replaceChildren()
    for (const existing of observation.records) {
      const row = document.createElement('div'),
        label = document.createElement('p')
      label.textContent = `${existing.record.target.hostId}: ${existing.record.target.path} · ${existing.domain ? `${existing.domain.skillId} · ${existing.domain.agent} · ${existing.domain.policy}` : 'Unverifiable domain identity; protected'} · recorded; current state not yet verified`
      row.append(label)
      for (const kind of ['update', 'remove']) {
        const button = document.createElement('button')
        button.className = 'hvir-button'
        button.textContent = `Review Full ${kind}`
        button.disabled = !existing.domain || existing.domain.policy !== 'managed'
        ports.onButton(button, (_event, current) => prepare(kind, current, existing))
        row.append(button)
      }
      element('delivery-list').append(row)
    }
    for (const operation of observation.operations) {
      const button = document.createElement('button')
      button.className = 'hvir-button'
      button.textContent = `Reconcile and review retained cleanup: ${operation.id}`
      ports.onButton(button, async (_event, current) => {
        const facts = await client.request('delivery.reconcile', {
          operation: operation.id,
          destination: 'delivery-target',
        })
        if (!current()) return
        if (facts.outcome !== 'completed') {
          ports.show(facts)
          ports.say(
            'Ownership or completion is unproven. Preserve these exact objects; inspect them in Settings for deliberate keep-files resolution.',
          )
          return
        }
        ports.review(
          'Clean exact unchanged retained objects',
          'The target and shared supporting directories stay in place. Only unchanged proven owned staging/preservation objects for this exact operation may be deleted.',
          facts,
          {
            perform: async () => {
              const result = await client.request('delivery.cleanup', {
                operation: operation.id,
                destination: 'delivery-target',
              })
              ports.show(result)
              ports.say(
                `Retained cleanup: ${result.outcome}. Target files remain in place.`,
              )
            },
          },
        )
      })
      element('delivery-list').append(button)
    }
    for (const entry of observation.domain.deliveries.filter(
      (entry) =>
        entry.workspace === ports.context().workspace?.id &&
        entry.target.hostId === ports.context().workspace?.host &&
        !observation.allOperationIds.includes(entry.operation) &&
        !observation.allRecordOperations.includes(entry.operation),
    )) {
      const button = document.createElement('button')
      button.className = 'hvir-button'
      button.textContent = `Review ending local metadata tracking: ${entry.skillId} · ${entry.operation}`
      ports.onButton(button, () =>
        ports.review(
          'End local metadata tracking for this resolved delivery',
          'All files stay in place. This clears only the selected local domain record after its exact core record and recovery evidence were resolved.',
          entry,
          {
            perform: async () => {
              const result = await forgetDeliveryMetadata(
                client,
                ports.context().workspace,
                entry.operation,
              )
              ports.show(result)
              ports.say(result.message)
            },
          },
        ),
      )
      element('delivery-list').append(button)
    }
    const facts = document.createElement('pre')
    facts.textContent = JSON.stringify(
      {
        operations: observation.operations,
        message:
          'Recorded presence survives disconnect. Settings → Extensions → Delivery recovery inspects exact objects, reconciles proven completion, cleans unchanged owned leftovers, or keeps files and ends tracking.',
      },
      null,
      2,
    )
    element('delivery-list').append(facts)
    ports.say(
      'Recorded SSH deliveries observed. An unavailable host is unknown, never proof that files are absent.',
    )
  })
  return { clear: () => element('delivery-list').replaceChildren() }
}
