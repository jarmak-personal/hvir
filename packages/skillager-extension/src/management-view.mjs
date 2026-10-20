import { readOperationReport } from './operation-report.mjs'
import { bindDeliveryView } from './delivery-view.mjs'
import { managementCli } from './management-cli.mjs'
import {
  absoluteLocalPath,
  registeredLibrary,
  acceptedSource,
  sameLibrary,
} from './management-contract.mjs'
import { prepareCopy } from './management-copy.mjs'
import { syncArgs } from './management-argv.mjs'
import { syncObservation } from './management-library.mjs'
import { syncReviewHash } from './management-sync-review.mjs'
import { copyChangeInput } from './exposure-operation.mjs'
import { bindExactReview } from './review-view.mjs'

/** Human controls consume metadata/actions; instruction review remains a separate D7 origin. */
export function bindManagementView(document, client) {
  const element = (id) => document.getElementById(id),
    commandDisabled = new WeakMap(),
    working = document.createElement('span')
  working.textContent = 'Working… '
  let context = { visible: false },
    observed,
    connection,
    source,
    prepared,
    busy = false,
    disposed = false,
    refreshQueued = false,
    revision = 0
  const listeners = []
  const say = (message) => {
    element('state').textContent = message
    if (busy) element('state').prepend(working)
  }
  const show = (value) => {
    element('result').textContent = JSON.stringify(value, null, 2)
  }
  function available(current = revision) {
    return !disposed && client.alive && context.visible && revision === current
  }
  function registerCommand(target) {
    const buttons =
      target.tagName === 'BUTTON'
        ? [target]
        : target.querySelectorAll('button[type="submit"], button:not([type])')
    for (const button of buttons) {
      button.dataset.managementCommand = ''
      commandDisabled.set(button, button.disabled)
      button.disabled ||= busy
    }
  }
  function setCommandDisabled(id, disabled) {
    const button = element(id)
    commandDisabled.set(button, disabled)
    button.disabled = busy || disabled
  }
  function presentWorking() {
    document.querySelector('main')?.setAttribute('aria-busy', String(busy))
    if (busy) element('state').prepend(working)
    else working.remove()
    for (const button of document.querySelectorAll('[data-management-command]'))
      button.disabled = busy || commandDisabled.get(button)
  }
  function clearPlan() {
    void prepared?.release?.()
    prepared = undefined
    element('review').hidden = true
  }
  function clearSource(revoke = true) {
    source = undefined
    setCommandDisabled('add-copy', true)
    clearPlan()
    if (revoke) revision++
    element('source-identity').textContent = ''
  }
  function local() {
    if (context.workspace?.host !== 'local' || context.workspace.root?.hostId !== 'local')
      throw new Error(
        'Open Manage skills from the exact local project/worktree for project copies or terminal setup',
      )
    return context.workspace
  }
  function connected() {
    if (!connection)
      throw new Error(
        'The current library is unavailable. Refresh the library to try again.',
      )
    return connection
  }
  function io(project = false) {
    return managementCli(client, project ? context : undefined)
  }
  async function guarded(work) {
    if (busy || !available()) return
    busy = true
    presentWorking()
    const current = ++revision
    try {
      await work(() => available(current))
    } catch (error) {
      if (available(current)) say(error.message)
    } finally {
      busy = false
      if (!disposed) presentWorking()
      if (refreshQueued && available()) {
        refreshQueued = false
        void guarded((current) => observeLibrary(current))
      }
    }
  }
  function on(id, event, work) {
    const target = element(id),
      callback = (event) => {
        event.preventDefault()
        void guarded((current) => work(event, current))
      }
    registerCommand(target)
    target.addEventListener(event, callback)
    listeners.push(() => target.removeEventListener(event, callback))
  }
  // Selection changes revoke previews even while a serialized command is pending.
  function onSelection(id, event, work = () => {}) {
    const target = element(id),
      callback = () => {
        revision++
        clearPlan()
        work()
      }
    target.addEventListener(event, callback)
    listeners.push(() => target.removeEventListener(event, callback))
  }
  async function action(id, input = {}, current = () => true) {
    let result
    try {
      result = await client.request('actions.invoke', { action: id, input })
    } catch (error) {
      if (current()) throw error
      return
    }
    if (current()) {
      show(result)
      say(
        result.message ??
          `${result.outcome ?? result.status ?? 'Result observed'} · ${id}`,
      )
    }
    return result
  }
  function review(title, summary, plan, task, technicalDetails = false) {
    prepared = {
      ...task,
      workspace: context.workspace
        ? JSON.parse(JSON.stringify(context.workspace))
        : undefined,
    }
    element('review-title').textContent = title
    element('review-summary').textContent = summary
    element('review-plan').textContent = JSON.stringify(plan, null, 2)
    element('review-details').open = !technicalDetails
    element('confirm-plan').textContent =
      task.action === 'operation-state'
        ? 'Acknowledge current facts; original completion unknown'
        : 'Confirm this exact plan'
    element('review').hidden = false
  }
  function exactWorkspace(task) {
    if (JSON.stringify(task.workspace) !== JSON.stringify(context.workspace))
      throw new Error(
        'The reviewed destination changed. Review again in the original workspace.',
      )
  }
  async function observeLibrary(current) {
    clearSource(false)
    const value = await io().run(['library', 'status', '--json'])
    if (!current()) return
    if (value.schema !== 'skillager.library-status.v1')
      throw new Error('Supported public library status is unavailable')
    observed = value.initialized ? registeredLibrary(value) : undefined
    const changed =
      observed && connection && JSON.stringify(observed) !== JSON.stringify(connection)
    element('connect-library').hidden = !changed
    setCommandDisabled('connect-library', !observed)
    if (changed) {
      clearSource()
      say('The registered library changed. Choose Use this library to continue.')
    } else {
      connection = observed
      say(observed ? '' : 'No personal library yet. Create one when ready.')
    }
    element('library-identity').textContent = observed
      ? `${observed.root.hostId}: ${observed.root.path}`
      : ''
    if (connection === observed && element('skill-id').value.trim())
      await observeSource(current)
  }
  on('observe-library', 'click', (_event, current) => observeLibrary(current))
  on('connect-library', 'click', async (_event, current) => {
    if (!observed) throw new Error('Refresh the current library first')
    const chosen = observed,
      fresh = registeredLibrary(await io().run(['library', 'status', '--json']))
    sameLibrary(chosen, fresh)
    if (chosen.gitMode !== fresh.gitMode)
      throw new Error('Library history mode changed. Refresh the library to review it.')
    if (!current()) return
    connection = fresh
    clearSource(false)
    element('connect-library').hidden = true
    say('')
    if (element('skill-id').value.trim()) await observeSource(current)
  })
  async function initialize(selection, current) {
    const result = await action('initialize-library', selection, current)
    if (!current() || result?.outcome !== 'verified') return
    observed = result.observed
    connection = result.connect ? result.observed : undefined
    setCommandDisabled('connect-library', false)
    element('connect-library').hidden = !!result.connect
    element('library-identity').textContent =
      `${result.connect ? 'Connected' : 'Observed; explicitly choose Connect'} ${observed.root.hostId}: ${observed.root.path} · ${observed.id} · history ${observed.gitMode}`
    say(`${result.message}. ${result.guidance}`)
  }
  on('create-library', 'click', (_event, current) =>
    initialize({ location: 'default' }, current),
  )
  on('initialize', 'submit', (_event, current) => {
    return initialize(
      {
        location: 'custom',
        root: absoluteLocalPath(element('library-path').value),
        git: element('git-history').checked,
      },
      current,
    )
  })
  on('preview-sync', 'click', async (_event, current) => {
    const library = connected(),
      value = syncObservation(
        await io(!!context.workspace).run(syncArgs(library)),
        library,
      )
    const reviewHash = await syncReviewHash(value)
    if (!current()) return
    review(
      'Review approved-source synchronization',
      `${library.root.hostId}: ${library.root.path}. Skillager owns approval, copying and preservation. Coverage ${value.coverage.complete ? 'complete' : 'incomplete'}; inspect all candidates and lineage outcomes.`,
      value,
      {
        action: 'sync-library',
        input: { library, reviewHash },
      },
    )
  })
  async function observeSource(current) {
    clearSource(false)
    const library = connected(),
      id = element('skill-id').value.trim()
    if (!id) return
    const value = await io().run(['library', 'status', id, '--json'])
    const selected = acceptedSource(value, library, id)
    if (!current()) return
    source = selected
    setCommandDisabled('add-copy', false)
    clearPlan()
    element('source-identity').textContent = ''
    say('')
  }
  on('observe-source', 'click', (_event, current) => observeSource(current))
  onSelection('skill-id', 'change', () => {
    if (busy) refreshQueued = true
    else void guarded((current) => observeSource(current))
  })
  function copyInput() {
    if (!source || source.id !== element('skill-id').value.trim())
      throw new Error('Choose a current accepted library skill first')
    local()
    return {
      library: connected(),
      skillId: source.id,
      hash: source.hash,
      agent: element('copy-agent').value,
      mode: element('copy-mode').value,
    }
  }
  on('add-copy', 'click', async () => {
    clearPlan()
    await action('add-copy', copyInput())
  })
  on('observe-copies', 'click', async (_event, current) => {
    local()
    const value = await io(true).run([
      'expose',
      '--list',
      '--all-agents',
      '--scope',
      'project',
      '--json',
    ])
    if (value.schema !== 'skillager.exposures.v1' || !Array.isArray(value.exposures))
      throw new Error('Supported current managed copies are unavailable')
    if (!current()) return
    show(value)
    element('managed-copies').replaceChildren()
    for (const item of value.exposures) {
      if (!['codex', 'claude'].includes(item.agent) || item.scope !== 'project') continue
      const row = document.createElement('div'),
        label = document.createElement('p')
      label.textContent = `${item.agent} ${item.mode === 'stub' ? 'Stub' : 'Full'} · ${item.target} · ${item.status}`
      row.append(label)
      for (const remove of [false, true]) {
        const button = document.createElement('button')
        button.className = 'hvir-button'
        button.textContent = remove ? 'Review Remove' : 'Review Update / mode change'
        registerCommand(button)
        button.addEventListener(
          'click',
          () =>
            void guarded(async (current) => {
              const input = remove
                ? {
                    library: connected(),
                    exposureId: item.exposure_id,
                    agent: item.agent,
                    target: { hostId: 'local', path: item.target },
                  }
                : {
                    ...copyInput(),
                    exposureId: item.exposure_id,
                    agent: item.agent,
                    target: { hostId: 'local', path: item.target },
                  }
              const prepared = await prepareCopy(io(true), input, local(), remove)
              if (!current()) return
              review(
                remove ? 'Review managed Remove' : 'Review managed Update / mode change',
                `${item.agent} · local: ${prepared.plan.target}. Inspect every before/after effect. Local edits requiring force are preserved.`,
                prepared.plan.preview,
                {
                  action: remove ? 'remove-copy' : 'change-exposure',
                  input: remove
                    ? { ...input, token: prepared.plan.token }
                    : copyChangeInput({ ...input, token: prepared.plan.token }),
                },
              )
            }),
          { signal: client.signal },
        )
        row.append(button)
      }
      element('managed-copies').append(row)
    }
  })
  on('confirm-plan', 'click', async () => {
    if (!prepared) throw new Error('Review one complete current plan first')
    const task = prepared
    exactWorkspace(task)
    task.validateSelection?.()
    if (
      task.action === 'change-exposure' &&
      JSON.parse(task.input.request).action === 'update-copy' &&
      JSON.parse(task.input.request).skillId !== element('skill-id').value.trim()
    )
      throw new Error(
        'The selected source changed. Select and review its current version again.',
      )
    prepared = undefined
    element('review').hidden = true
    if (task.perform) await task.perform()
    else await action(task.action, task.input)
  })
  on('dismiss-plan', 'click', () => clearPlan())
  on('setup-project', 'click', async () => {
    local()
    await action('setup-project', { agent: element('setup-agent').value })
  })
  on('pending-operations', 'click', async (_event, current) => {
    const value = await action('operation-state', { mode: 'list' })
    if (!current()) return
    element('pending-list').replaceChildren()
    for (const id of value.ids ?? []) {
      const button = document.createElement('button')
      button.className = 'hvir-button'
      button.textContent = `Inspect and reconcile ${id}`
      registerCommand(button)
      button.addEventListener(
        'click',
        () =>
          void guarded(async (current) => {
            const report = await readOperationReport(client, id)
            if (!current()) return
            element('operation-report').textContent = JSON.stringify(report, null, 2)
            const observed = await action('operation-state', {
              mode: 'observe',
              operationId: id,
            })
            if (!current() || observed.outcome !== 'observed') return
            review(
              'Inspect supported current facts',
              observed.message,
              JSON.parse(observed.observation),
              {
                action: 'operation-state',
                input: {
                  mode: 'acknowledge',
                  operationId: id,
                  observation: observed.observation,
                },
              },
            )
          }),
        { signal: client.signal },
      )
      element('pending-list').append(button)
    }
  })
  const sourceChanged = () => clearSource()
  element('skill-id').addEventListener('input', sourceChanged)
  listeners.push(() => element('skill-id').removeEventListener('input', sourceChanged))
  for (const id of ['copy-agent', 'copy-mode']) onSelection(id, 'change')
  const browse = element('open-exposure-browser'),
    openLibrary = async () => {
      if (!available()) return
      const current = revision
      try {
        await client.request('viewer.open-own', { contributionId: 'library' })
      } catch (error) {
        if (available(current)) say(error.message)
      }
    }
  browse.addEventListener('click', openLibrary)
  listeners.push(() => browse.removeEventListener('click', openLibrary))
  const delivery = bindDeliveryView(document, client, {
    on,
    onSelection,
    context: () => context,
    library: connected,
    source: () => source,
    review,
    say,
    show,
    onButton: (button, work) => {
      registerCommand(button)
      button.addEventListener(
        'click',
        (event) => {
          event.preventDefault()
          void guarded((current) => work(event, current))
        },
        { signal: client.signal },
      )
    },
  })
  const unlisten = client.listen((message) => {
    if (message.kind !== 'context') return
    if (JSON.stringify(message.context.workspace) !== JSON.stringify(context.workspace)) {
      clearPlan()
      element('managed-copies').replaceChildren()
      delivery.clear()
      revision++
    }
    if (!message.context.visible) revision++
    const renewed = message.context.visible && !context.visible
    context = message.context
    const row = context.input?.row
    let selectionChanged = false
    if (
      row?.source === 'library' &&
      typeof row.id === 'string' &&
      row.id !== element('skill-id').value.trim()
    ) {
      clearSource()
      element('skill-id').value = row.id
      selectionChanged = true
    }
    const target = context.workspace
    element('destination').textContent = target?.root
      ? `${target.name ?? 'Project'} · ${target.host}: …/${target.root.path.split('/').filter(Boolean).slice(-2).join('/')}`
      : 'Choose a project for project actions.'
    element('destination-details').hidden = !target?.root
    element('destination-identity').textContent = target?.root
      ? `${target.host}: ${target.root.path}\nWorkspace: ${target.id}`
      : ''
    if (renewed || (selectionChanged && context.visible)) {
      if (busy) refreshQueued = true
      else void guarded((current) => observeLibrary(current))
    }
  })
  const exactReview = bindExactReview(document, client, {
    context: () => context,
    library: connected,
    say,
    action,
  })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      working.remove()
      clearPlan()
      exactReview.dispose()
      unlisten()
      for (const release of listeners) release()
      revision++
    },
  }
}
