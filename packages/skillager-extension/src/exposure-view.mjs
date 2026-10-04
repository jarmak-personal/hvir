import { prepareExposureChange } from './exposure-operation.mjs'
import { syncArgs } from './management-argv.mjs'
import { publicSyncObservation } from './management-sync-observation.mjs'

const labels = {
  group: 'Group skills behind one Router',
  'set-members': 'Change Router members',
  ungroup: 'Ungroup into individual skills',
  'adopt-native': 'Adopt an existing native skill',
}
export function bindExposureView(document, client, ports) {
  const el = (id) => document.getElementById(id)
  let routers = [],
    origins = []
  function options(id, values, label) {
    el(id).replaceChildren()
    for (const item of values) {
      const option = document.createElement('option')
      option.value = String(values.indexOf(item))
      option.textContent = label(item)
      el(id).append(option)
    }
  }
  ports.on('observe-advanced', 'click', async (_event, current) => {
    ports.local()
    ports.clear()
    routers = []
    origins = []
    for (const id of [
      'advanced-router',
      'advanced-origin',
      'advanced-replacements',
      'advanced-departures',
    ])
      el(id).replaceChildren()
    ports.say('Observing current Routers and preserved native originals…')
    const io = ports.io(),
      library = ports.library(),
      agent = el('copy-agent').value,
      listed = await io.run([
        'expose',
        '--list',
        '--agent',
        agent,
        '--scope',
        'project',
        '--json',
      ])
    let preserved, nativeObservationError
    try {
      preserved = publicSyncObservation(await io.run(syncArgs(library)), library)
      if (!preserved.coverage.complete)
        throw new Error('Complete native preservation observations are unavailable')
    } catch (error) {
      nativeObservationError = error.message
      preserved = undefined
    }
    if (listed.schema !== 'skillager.exposures.v1' || !Array.isArray(listed.exposures))
      throw new Error('Current Router and standalone copy observations are unavailable')
    if (!current()) return
    ports.clear()
    routers = listed.exposures.filter(
      (item) =>
        item.mode === 'router' && item.agent === agent && item.scope === 'project',
    )
    origins = (preserved?.lineages ?? []).flatMap((lineage) =>
      (lineage.origins ?? [])
        .filter(
          (origin) =>
            origin.native?.agent === agent && origin.native?.scope === 'project',
        )
        .map((origin) => ({
          origin,
          canonical: lineage.canonical,
          preservation: lineage.preservation,
        })),
    )
    options(
      'advanced-router',
      routers,
      (item) => `${item.tag ?? item.exposure_id} · ${item.target}`,
    )
    options(
      'advanced-origin',
      origins,
      (item) => `${item.canonical.skill_id} · ${item.origin.path} · ${item.preservation}`,
    )
    options(
      'advanced-replacements',
      listed.exposures.filter((item) => item.mode !== 'router'),
      (item) => `${item.exposure_id} · ${item.target}`,
    )
    el('advanced-replacements')
      .querySelectorAll('option')
      .forEach((option) => {
        const item = listed.exposures.filter((item) => item.mode !== 'router')[
          Number(option.value)
        ]
        option.value = item.exposure_id
      })
    el('advanced-observation').textContent = JSON.stringify(
      { agent, routers, preserved, nativeObservationError },
      null,
      2,
    )
    ports.say(
      nativeObservationError
        ? `Current Routers observed. Native adoption needs complete preservation metadata: ${nativeObservationError}. Resolve through the public CLI, then observe again.`
        : 'Current Router and preserved native choices observed. Select the exact operation and files to change.',
    )
    updateMembers()
  })
  function updateMembers() {
    ports.clear()
    const router = routers[Number(el('advanced-router').value)]
    el('advanced-members').value = (router?.skill_ids ?? []).join('\n')
    el('advanced-departures').replaceChildren()
    for (const member of router?.skill_ids ?? []) {
      const label = document.createElement('label'),
        select = document.createElement('select')
      label.textContent = `If ${member} leaves the Router: `
      select.className = 'hvir-input'
      select.dataset.member = member
      for (const [value, text] of [
        ['', 'Choose explicitly'],
        ['native', 'Full skill'],
        ['stub', 'Stub'],
        ['remove', 'Remove from this Router; do not create a copy'],
      ]) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        select.append(option)
      }
      label.append(select)
      el('advanced-departures').append(label)
    }
  }
  ports.on('advanced-router', 'change', () => updateMembers())
  ports.on('advanced-operation', 'change', () => {
    ports.clear()
    const action = el('advanced-operation').value
    for (const [id, visible] of [
      ['advanced-name-row', action === 'group'],
      ['advanced-members-row', ['group', 'set-members'].includes(action)],
      ['advanced-router-row', ['set-members', 'ungroup'].includes(action)],
      ['advanced-origin-row', action === 'adopt-native'],
      ['advanced-replace-row', ['group', 'set-members'].includes(action)],
      ['advanced-departures', action === 'set-members'],
    ])
      el(id).hidden = !visible
    if (action === 'group') el('advanced-members').value = ''
    else if (action === 'set-members') updateMembers()
  })
  ports.on('preview-advanced', 'click', async (_event, current) => {
    const action = el('advanced-operation').value,
      library = ports.library(),
      agent = el('copy-agent').value,
      mode = el('copy-mode').value,
      router = routers[Number(el('advanced-router').value)],
      origin = origins[Number(el('advanced-origin').value)]
    const request = { schema: 'skillager.exposure-request.v1', action }
    if (['group', 'set-members'].includes(action)) {
      request.library_id = library.id
      request.members = el('advanced-members')
        .value.split(/[\s,]+/u)
        .filter(Boolean)
      request.replace = [...el('advanced-replacements').selectedOptions].map(
        (option) => ({ exposure_id: option.value }),
      )
      if (action === 'group') request.name = el('advanced-name').value
      else {
        if (!router) throw new Error('Observe and select the existing Router first')
        request.router_id = router.exposure_id
        request.departures = [...el('advanced-departures').querySelectorAll('select')]
          .filter((select) => !request.members.includes(select.dataset.member))
          .map((select) => ({ skill_id: select.dataset.member, mode: select.value }))
      }
    } else if (action === 'ungroup') {
      if (!router) throw new Error('Observe and select the existing Router first')
      request.router_id = router.exposure_id
      request.mode = mode
    } else {
      if (!origin)
        throw new Error(
          'Sync the approved original through the public CLI, then observe its preserved native occurrence',
        )
      request.origin_id = origin.origin.origin_id
      request.source = {
        library_id: origin.canonical.library_id,
        skill_id: origin.canonical.skill_id,
      }
      request.mode = mode
    }
    const input = { library, agent, request: JSON.stringify(request) },
      prepared = await prepareExposureChange(ports.io(), input, ports.local())
    if (!current()) return
    const files = prepared.plan.targets.flatMap((target) =>
      target.file_effects.map(
        (effect) =>
          `${effect.action}: ${target.path}${effect.path === '.' ? '' : '/' + effect.path}`,
      ),
    )
    ports.review(
      labels[action],
      `${agent} · local: ${ports.local().root.path}. ${
        action === 'adopt-native'
          ? 'Replace this original with the selected Full/Stub form only after Skillager proves its bytes and modes are preserved in your library.'
          : action === 'ungroup'
            ? 'Create individual copies in the selected mode and remove this Router. Its curated tag remains.'
            : 'Use exactly the complete desired membership. Only selected standalone copies are replaced. Each departing member follows its explicit choice.'
      }\n${files.join('\n')}`,
      prepared.plan,
      {
        action: 'change-exposure',
        input: { ...input, token: prepared.plan.confirmation_token },
      },
    )
  })
  for (const id of [
    'advanced-name',
    'advanced-members',
    'advanced-origin',
    'advanced-replacements',
    'advanced-departures',
  ])
    ports.on(id, 'input', () => ports.clear())
  return {
    clear() {
      routers = []
      origins = []
      for (const id of [
        'advanced-router',
        'advanced-origin',
        'advanced-replacements',
        'advanced-departures',
      ])
        el(id).replaceChildren()
    },
  }
}
