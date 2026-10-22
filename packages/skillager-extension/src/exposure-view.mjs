import { mountSkillTasks } from './skill-task-template.mjs'
/* global AbortController */
import { managementCli } from './management-cli.mjs'
import { registeredLibrary, sameLibrary } from './management-contract.mjs'
import { localWorkspace } from './catalog.mjs'
import { prepareExposureChange } from './exposure-operation.mjs'
import {
  observeExposures,
  selectedRouter,
  observeNative,
} from './exposure-observation.mjs'
import { bindExposureMembers } from './exposure-members.mjs'

const titles = {
  group: 'Group skills',
  'set-members': 'Edit Router members',
  ungroup: 'Ungroup Router',
  'adopt-native': 'Replace original',
}
const names = { native: 'Full', stub: 'Stub', remove: 'Remove' }
const memberCount = (count) => `${count} ${count === 1 ? 'member' : 'members'}`

/** Selected exposure tasks; CLI plans and D4 retain mutation and uncertainty authority. */
export function bindExposureView(document, client, ports) {
  mountSkillTasks(document)
  const el = (id) => document.getElementById(`exposure-${id}`),
    context = ports.context,
    choiceHome = el('choice-row').parentNode
  let selection,
    library,
    router,
    exposures = [],
    preservation,
    canImport = false,
    action,
    prepared,
    departures = new Map(),
    replacements = new Set(),
    generation = 0,
    working,
    submitted = false,
    completed = false,
    taskReady = false,
    disposed = false,
    adoptionMode = 'native',
    routerEvents,
    choiceEvents
  const row = () => selection?.row
  const agent = () =>
    row()?.exposure?.agent ?? row()?.agent ?? document.getElementById('task-agent').value
  const workspace = () => localWorkspace(context().workspace)
  const available = (revision = generation) =>
    !disposed &&
    client.alive &&
    context().visible &&
    revision === generation &&
    !!row() &&
    !!workspace() &&
    row().host === 'local' &&
    (row().source !== 'project' || row().workspaceId === workspace().id)
  const say = (message) => {
    el('state').textContent = message
  }
  const scoped = (revision) => ({
    get alive() {
      return available(revision)
    },
    get visible() {
      return context().visible
    },
    delay: (ms) => client.delay(ms),
    request(capability, input) {
      if (!(capability === 'connector.output' && input.release) && !available(revision))
        throw new Error('The selected skill or project changed.')
      return client.request(capability, input)
    },
  })
  const io = (revision = generation, project = true) =>
    managementCli(scoped(revision), project ? context() : undefined)
  const on = (id, event, work) =>
    el(id).addEventListener(event, work, { signal: client.signal })
  const selectedChoice = () =>
    preservation?.candidates.find(
      (item) =>
        item.source.skill_id === el('choice').value && item.status === 'available',
    )
  function controls() {
    ports.activity?.(submitted)
    const busy = !!working || submitted,
      original = row()?.kind === 'Project original',
      isRouter = row()?.kind === 'Installed Router',
      canReplace = preservation?.candidates.some((item) => item.status === 'available'),
      canUse =
        original &&
        ['codex', 'claude'].includes(row()?.agent) &&
        (canReplace || canImport)
    document.getElementById('router-content').hidden = !isRouter || !!action
    el('task').dataset.content = isRouter ? 'router' : 'skill'
    el('task').setAttribute('aria-busy', String(!!working?.phase))
    el('preview').textContent =
      working?.phase === 'prepare'
        ? 'Preparing…'
        : working?.phase === 'review'
          ? 'Reviewing…'
          : 'Review changes'
    el('confirm').textContent =
      working?.phase === 'apply'
        ? 'Applying…'
        : action === 'group'
          ? 'Group'
          : action === 'set-members'
            ? 'Save members'
            : action === 'ungroup'
              ? 'Ungroup'
              : `Replace with ${names[adoptionMode]}`
    el('context').hidden = !available() || !!action || (!isRouter && !canUse)
    el('preservation-details').hidden = !original
    el('group').hidden =
      !available() || isRouter || !(row()?.source === 'library' || row()?.canonical)
    el('group').disabled = busy
    for (const id of ['edit', 'ungroup']) {
      el(id).hidden = !isRouter
      el(id).disabled =
        busy ||
        !router ||
        !library ||
        router.member_sources.some((member) => member.source_library_id !== library.id)
    }
    for (const id of ['full', 'stub']) {
      el(id).hidden = !canUse
      el(id).disabled = busy || (!canImport && !selectedChoice())
    }
    el('replacement').hidden = !canUse
    el('choice').disabled = busy
    el('refresh').disabled = busy
    for (const id of ['preview', 'confirm'])
      el(id).disabled = busy || !available() || !taskReady
    el('cancel').disabled = submitted
    el('preview').hidden = !!prepared || completed
    el('confirm').hidden = !prepared
    el('fields').hidden = !!prepared || completed
    el('review').hidden = !prepared
  }
  function invalidatePlan() {
    prepared = undefined
    controls()
  }
  const picker = bindExposureMembers(document, client, {
    library: () => library,
    available: () => available() && !!action && !submitted && !working,
    io: () => io(generation, false),
    changed() {
      invalidatePlan()
      renderChoices()
    },
    say,
  })
  async function guard(work, phase) {
    if (!available() || working || submitted) return
    const owner = { revision: generation, phase }
    working = owner
    controls()
    try {
      await work(owner.revision)
    } catch (error) {
      if (available(owner.revision)) say(error.message)
    } finally {
      if (working === owner) {
        working = undefined
        controls()
      }
    }
  }
  async function currentLibrary(revision, allowAbsent = false) {
    const status = await io(revision).run(['library', 'status', '--json'])
    if (
      allowAbsent &&
      status.schema === 'skillager.library-status.v1' &&
      status.status === 'not-initialized' &&
      status.initialized === false &&
      status.library === null &&
      status.git === null &&
      status.skill === null
    )
      return null
    const observed = registeredLibrary(status),
      expected =
        selection.library ?? (row().canonical ? { id: row().canonical.library_id } : null)
    if (
      expected &&
      (expected.id !== observed.id ||
        (expected.root && expected.root !== observed.root.path))
    )
      throw new Error(
        'This source belongs to a different library. Select its current library entry.',
      )
    if (library) sameLibrary(library, observed)
    return observed
  }
  function renderPreservation(message) {
    const choices = preservation?.candidates ?? [],
      availableChoices = choices.filter((item) => item.status === 'available')
    ports.preservation?.(
      availableChoices.length
        ? {
            file: { hostId: row().host, path: row().path },
            sources: availableChoices.map((item) => item.source),
          }
        : undefined,
    )
    el('choice').replaceChildren()
    if (availableChoices.length !== 1) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = 'Choose a preserved library version'
      el('choice').append(option)
    }
    for (const item of choices) {
      const option = document.createElement('option')
      option.value = item.source.skill_id
      option.textContent = `${item.source.skill_id}${item.status === 'available' ? '' : ' · unavailable'}`
      option.disabled = item.status !== 'available'
      el('choice').append(option)
    }
    if (availableChoices.length === 1)
      el('choice').value = availableChoices[0].source.skill_id
    el('choice-row').hidden = availableChoices.length < 2
    el('availability').textContent = 'Preservation details'
    el('preservation-reason').textContent =
      message ??
      (availableChoices.length
        ? `Skillager verified the original against ${availableChoices.map((item) => item.source.skill_id).join(', ')}. Replacement requires its own file review.`
        : [preservation?.reason, ...choices.map((item) => item.reason)]
            .filter(Boolean)
            .join('\n') ||
          'Use Full or Stub to review saving this original in your library and replacing its project copy.')
    controls()
  }
  function renderRouter() {
    routerEvents?.abort()
    routerEvents = new AbortController()
    const list = document.getElementById('router-members')
    list.replaceChildren()
    for (const member of router?.member_sources ?? []) {
      const item = document.createElement('li'),
        button = document.createElement('button'),
        details = document.createElement('details'),
        summary = document.createElement('summary'),
        identity = document.createElement('p')
      button.className = 'hvir-button'
      button.textContent = member.skill_id.startsWith('lib/')
        ? member.skill_id.slice(4)
        : member.skill_id
      button.disabled = !member.source_library_id
      button.addEventListener(
        'click',
        () =>
          void guard(async (revision) => {
            const value = await io(revision, false).run([
                'library',
                'status',
                member.skill_id,
                '--json',
              ]),
              observed = registeredLibrary(value)
            if (
              observed.id !== member.source_library_id ||
              value.skill?.id !== member.skill_id ||
              value.skill?.status === 'missing' ||
              !value.skill?.entrypoint
            )
              throw new Error('This member is not available in the connected library.')
            if (!available(revision)) return
            await ports.choose(
              {
                id: member.skill_id,
                name: value.skill.name ?? member.skill_id,
                path: value.skill.entrypoint,
                source: 'library',
                host: 'local',
                kind: 'Your library',
                status: value.skill.acceptance ?? 'observed',
              },
              { initialized: true, id: observed.id, root: observed.root.path },
            )
          }),
        { signal: routerEvents.signal },
      )
      summary.textContent = 'Source identity'
      identity.textContent = `${member.source_library_id ?? 'Library identity unavailable'} · ${member.skill_id}`
      details.append(summary, identity)
      item.append(button, details)
      list.append(item)
    }
    document.getElementById('router-state').textContent = router
      ? memberCount(router.skill_ids.length)
      : 'Loading members…'
  }
  async function refresh() {
    if (!available() || action || submitted) return
    generation++
    working = undefined
    router = undefined
    library = undefined
    preservation = undefined
    canImport = false
    const isRouter = row().kind === 'Installed Router',
      original = row().kind === 'Project original'
    if (!isRouter && !original) {
      controls()
      return
    }
    if (isRouter) renderRouter()
    if (original) renderPreservation('Checking this original’s preservation…')
    await guard(async (revision) => {
      try {
        if (!['codex', 'claude'].includes(row().exposure?.agent ?? row().agent))
          throw new Error('Use Full or Stub in a Codex or Claude project location.')
        if (isRouter) {
          const observed = await observeExposures(io(revision), workspace(), agent())
          if (!available(revision)) return
          exposures = observed
          router = selectedRouter(exposures, row())
          renderRouter()
        }
        const observed = await currentLibrary(revision, original)
        if (!available(revision)) return
        library = observed
        if (original && !library) {
          canImport = true
          renderPreservation()
          return
        }
        if (original) {
          const value = await observeNative(
            io(revision),
            row(),
            workspace(),
            agent(),
            library,
          )
          if (!available(revision)) return
          preservation = value
          canImport =
            value.status === 'unavailable' && value.origin?.entrypoint === row().path
          renderPreservation()
        }
      } catch (error) {
        if (!available(revision)) return
        if (original) renderPreservation(error.message)
        else
          document.getElementById('router-state').textContent =
            `${router ? `${memberCount(router.skill_ids.length)} · ` : ''}${error.message}`
      }
    })
  }
  function renderChoices() {
    choiceEvents?.abort()
    choiceEvents = new AbortController()
    const desired = picker.ids(),
      leaving = (router?.skill_ids ?? []).filter((id) => !desired.includes(id)),
      departureList = el('departures'),
      replacementList = el('replacements')
    departureList.replaceChildren()
    departureList.hidden = action !== 'set-members' || !leaving.length
    for (const id of leaving) {
      const label = document.createElement('label'),
        select = document.createElement('select')
      label.textContent = `${id} leaves the Router: `
      select.className = 'hvir-input'
      select.dataset.skillId = id
      for (const [value, title] of [
        ['', 'Choose a result'],
        ['native', 'Full'],
        ['stub', 'Stub'],
        ['remove', 'Remove'],
      ]) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = title
        select.append(option)
      }
      select.value = departures.get(id) ?? ''
      select.addEventListener(
        'change',
        () => {
          departures.set(id, select.value)
          invalidatePlan()
        },
        { signal: choiceEvents.signal },
      )
      label.append(select)
      departureList.append(label)
    }
    replacementList.replaceChildren()
    const copies = exposures.filter(
      (item) =>
        ['native', 'stub'].includes(item.mode) &&
        item.source_library_id === library?.id &&
        desired.includes(item.skill_id),
    )
    for (const id of replacements)
      if (!copies.some((item) => item.exposure_id === id)) replacements.delete(id)
    replacementList.hidden = !['group', 'set-members'].includes(action) || !copies.length
    if (!replacementList.hidden) {
      const title = document.createElement('p')
      title.textContent = 'Also replace these standalone copies:'
      replacementList.append(title)
      for (const item of copies) {
        const label = document.createElement('label'),
          input = document.createElement('input'),
          details = document.createElement('details'),
          summary = document.createElement('summary'),
          identity = document.createElement('p')
        input.type = 'checkbox'
        input.dataset.exposureId = item.exposure_id
        input.checked = replacements.has(item.exposure_id)
        input.addEventListener(
          'change',
          () => {
            if (input.checked) replacements.add(item.exposure_id)
            else replacements.delete(item.exposure_id)
            invalidatePlan()
          },
          { signal: choiceEvents.signal },
        )
        label.append(
          input,
          `${item.skill_id.slice(4)} · ${names[item.mode]} · ${item.target}`,
        )
        summary.textContent = 'Copy identity'
        identity.textContent = `${item.source_library_id} · ${item.skill_id} · ${item.exposure_id}`
        details.append(summary, identity)
        replacementList.append(label, details)
      }
    }
  }
  async function start(next, mode) {
    if (!available() || working || submitted) return
    if (next === 'adopt-native' && !selectedChoice()) {
      if (preservation?.candidates.some((item) => item.status === 'available')) {
        adoptionMode = mode ?? 'native'
        action = next
        ports.expanded(true)
        taskReady = false
        el('task').hidden = false
        el('fields').prepend(el('choice-row'))
        el('title').textContent = `Use ${names[adoptionMode]}`
        say('Choose a library version.')
        controls()
        return
      }
      if (!canImport) {
        say('Refresh this skill before choosing its project copy.')
        return
      }
      return ports.saveAndUse?.(mode ?? 'native')
    }
    adoptionMode = mode ?? 'native'
    action = next
    completed = false
    taskReady = false
    prepared = undefined
    departures.clear()
    replacements.clear()
    el('task').hidden = false
    el('title').textContent = titles[action]
    el('destination').textContent =
      `${agent() === 'claude' ? 'Claude' : 'Codex'} · ${workspace().name ?? 'Project'}`
    el('destination').title = `local: ${workspace().root.path}`
    el('name-row').hidden = action !== 'group'
    el('name').value = ''
    el('mode-row').hidden = action !== 'ungroup'
    el('mode').value = 'native'
    el('picker').hidden = !['group', 'set-members'].includes(action)
    el('operation-details').hidden = true
    el('reconcile').hidden = true
    say('')
    // Bind the agent before the ordinary task is retired.
    el('task').dataset.agent = agent()
    ports.expanded(true)
    const taskRevision = generation
    await guard(async (revision) => {
      const observedLibrary = await currentLibrary(revision)
      if (!available(revision)) return
      const observedExposures = await observeExposures(
        io(revision),
        workspace(),
        taskAgent(),
      )
      if (!available(revision)) return
      library = observedLibrary
      exposures = observedExposures
      if (['set-members', 'ungroup'].includes(action)) {
        router = selectedRouter(exposures, row())
        if (router.member_sources.some((item) => item.source_library_id !== library.id))
          throw new Error(
            'This Router has members from a different or unknown library. Inspect its source identities.',
          )
        renderRouter()
      }
      if (action === 'adopt-native' && !selectedChoice())
        throw new Error('Choose an available preserved library version first.')
      taskReady = true
    }, 'prepare')
    if (!available(taskRevision) || !taskReady) return
    if (['group', 'set-members'].includes(action)) {
      picker.start(
        action === 'set-members'
          ? (router?.skill_ids.map((id) => ({ id, name: id })) ?? [])
          : [{ id: row().canonical?.skill_id ?? row().id, name: row().name }],
      )
    }
    renderChoices()
    controls()
    if (action === 'adopt-native') await review()
  }
  const taskAgent = () => el('task').dataset.agent ?? agent()
  function request() {
    if (!library)
      throw new Error('Connect the current library before reviewing this change.')
    if (action === 'adopt-native') {
      const chosen = selectedChoice()
      if (!chosen) throw new Error('Choose an available preserved library version.')
      return chosen.requests[adoptionMode]
    }
    const base = { schema: 'skillager.exposure-request.v1', action }
    if (action === 'ungroup') {
      if (!router) throw new Error('Select the current Router first.')
      return { ...base, router_id: router.exposure_id, mode: el('mode').value }
    }
    const members = picker.ids(),
      replace = [...replacements].map((exposure_id) => ({ exposure_id }))
    if (action === 'group')
      return {
        ...base,
        name: el('name').value.trim(),
        library_id: library.id,
        members,
        replace,
      }
    if (!router) throw new Error('Select the current Router first.')
    const leaving = router.skill_ids.filter((id) => !members.includes(id))
    if (leaving.some((id) => !departures.get(id)))
      throw new Error('Choose Full, Stub or Remove for each departing member.')
    return {
      ...base,
      router_id: router.exposure_id,
      library_id: library.id,
      members,
      replace,
      departures: leaving.map((skill_id) => ({
        skill_id,
        mode: departures.get(skill_id),
      })),
    }
  }
  const review = () =>
    guard(async (revision) => {
      invalidatePlan()
      const selected = JSON.stringify(request()),
        input = { library, agent: taskAgent(), request: selected },
        result = await prepareExposureChange(io(revision), input, workspace())
      if (!available(revision)) return
      if (selected !== JSON.stringify(request()))
        throw new Error('Selection changed. Review the complete current selection again.')
      prepared = {
        input: { ...input, token: result.plan.confirmation_token },
        plan: result.plan,
        revision,
        selected,
      }
      const plan = result.plan,
        wanted = plan.request
      el('summary').textContent = [
        `${taskAgent()} · local: ${workspace().root.path}`,
        action === 'adopt-native'
          ? `Replace ${row().path.slice(0, -9)} with ${names[adoptionMode]}. Preserved library version: ${wanted.source.skill_id}.`
          : action === 'ungroup'
            ? `Create ${names[wanted.mode]} copies for ${(plan.group?.before_members ?? []).join(', ')}. Remove this Router; keep its curated tag.`
            : `Router members: ${wanted.members.join(', ') || '(none)'}.`,
        ...(wanted.departures ?? []).map(
          (item) => `${item.skill_id}: ${names[item.mode]}`,
        ),
        ...(wanted.replace ?? []).map(
          (item) =>
            `Replace standalone: ${exposures.find((copy) => copy.exposure_id === item.exposure_id)?.target ?? item.exposure_id}`,
        ),
      ].join('\n')
      el('effects').replaceChildren(
        ...plan.targets.flatMap((target) =>
          target.file_effects.map((effect) => {
            const item = document.createElement('li')
            item.textContent = `${effect.action}: ${target.path}${effect.path === '.' ? '' : '/' + effect.path}`
            return item
          }),
        ),
      )
      el('plan').textContent = JSON.stringify(plan, null, 2)
      say('')
      controls()
      el('confirm').focus()
    }, 'review')
  on('preview', 'click', () => void review())
  on(
    'confirm',
    'click',
    () =>
      void guard(async (revision) => {
        const task = prepared
        if (
          !task ||
          task.revision !== revision ||
          task.selected !== JSON.stringify(request())
        ) {
          invalidatePlan()
          throw new Error(
            'Selection changed. Review the complete current selection again.',
          )
        }
        const origin = context().workspace,
          original = selection,
          selected = () =>
            !disposed &&
            selection === original &&
            JSON.stringify(origin) === JSON.stringify(context().workspace)
        submitted = true
        controls()
        try {
          const result = await client.request('actions.invoke', {
            action: 'change-exposure',
            input: task.input,
          })
          ports.changed?.(result, origin)
          if (!selected()) return
          prepared = undefined
          el('result').textContent = JSON.stringify(result, null, 2)
          el('operation-details').hidden = false
          el('reconcile').hidden = result?.outcome !== 'uncertain'
          if (result?.outcome === 'verified') {
            completed = true
            say('Changes saved. Restart the agent to use them.')
            el('fields').hidden = true
            el('review').hidden = true
            el('preview').hidden = true
            el('confirm').hidden = true
            el('cancel').textContent = 'Done'
          } else
            say(
              result?.message ??
                result?.reason ??
                'Completion is unknown. Inspect the operation before another change.',
            )
        } catch (error) {
          ports.changed?.(undefined, origin, error)
          if (selected()) say(error.message)
          if (available(revision)) prepared = undefined
          throw error
        } finally {
          submitted = false
          if (!available(revision)) {
            controls()
            if (available()) void refresh()
          }
        }
      }, 'apply'),
  )
  function close() {
    if (submitted) return
    generation++
    working = undefined
    action = prepared = undefined
    completed = false
    picker.stop()
    choiceEvents?.abort()
    el('task').hidden = true
    el('cancel').textContent = 'Cancel'
    choiceHome.append(el('choice-row'))
    ports.expanded(false)
    void refresh()
  }
  on('cancel', 'click', close)
  on('group', 'click', () => void start('group'))
  on('edit', 'click', () => void start('set-members'))
  on('ungroup', 'click', () => void start('ungroup'))
  on('full', 'click', () => void start('adopt-native', 'native'))
  on('stub', 'click', () => void start('adopt-native', 'stub'))
  on('choice', 'change', () => {
    invalidatePlan()
    if (action === 'adopt-native' && selectedChoice())
      void start('adopt-native', adoptionMode)
  })
  on('name', 'input', invalidatePlan)
  on('mode', 'change', invalidatePlan)
  on('refresh', 'click', () => void refresh())
  on(
    'reconcile',
    'click',
    () =>
      void client
        .request('viewer.open-own', { contributionId: 'management' })
        .catch((error) => say(error.message)),
  )
  return {
    async select(input, options = {}) {
      routerEvents?.abort()
      choiceEvents?.abort()
      generation++
      working = undefined
      action = prepared = undefined
      completed = false
      selection = input
      ports.preservation?.(undefined)
      library = router = preservation = undefined
      canImport = false
      exposures = []
      picker.stop()
      el('task').hidden = true
      el('cancel').textContent = 'Cancel'
      document.getElementById('router-content').hidden =
        row()?.kind !== 'Installed Router'
      controls()
      choiceHome.append(el('choice-row'))
      if (input) {
        const preparation = refresh(),
          revision = generation
        await preparation
        if (available(revision) && selection === input && options.mode) {
          if (
            !canImport &&
            !preservation?.candidates.some((item) => item.status === 'available')
          )
            throw new Error(
              el('preservation-reason').textContent ||
                'Refresh this skill before choosing its project copy.',
            )
          await start('adopt-native', options.mode)
        }
      }
    },
    refresh,
    contextChanged() {
      choiceHome.append(el('choice-row'))
      routerEvents?.abort()
      choiceEvents?.abort()
      generation++
      working = undefined
      if (action) ports.expanded(false)
      action = prepared = undefined
      completed = false
      picker.stop()
      el('task').hidden = true
      controls()
      if (available()) void refresh()
    },
    visibilityChanged() {
      routerEvents?.abort()
      choiceEvents?.abort()
      generation++
      working = prepared = undefined
      taskReady = false
      picker.stop()
      controls()
      if (available() && el('reconcile').hidden) void refresh()
    },
    dispose() {
      routerEvents?.abort()
      choiceEvents?.abort()
      disposed = true
      generation++
      working = undefined
      picker.stop()
      controls()
    },
  }
}
