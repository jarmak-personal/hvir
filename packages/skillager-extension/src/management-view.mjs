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
import { bindExactReview } from './review-view.mjs'

/** Human controls consume metadata/actions; instruction review remains a separate D7 origin. */
export function bindManagementView(document, client) {
  const element = (id) => document.getElementById(id)
  let context = { visible: false },
    observed,
    connection,
    source,
    prepared,
    busy = false,
    revision = 0
  const listeners = []
  const say = (message) => {
    element('state').textContent = message
  }
  const show = (value) => {
    element('result').textContent = JSON.stringify(value, null, 2)
  }
  function clearPlan() {
    prepared = undefined
    element('review').hidden = true
  }
  function clearSource() {
    source = undefined
    clearPlan()
    revision++
    element('source-identity').textContent =
      'Select the current accepted source version explicitly for this skill.'
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
      throw new Error('Observe and explicitly connect the current personal library first')
    return connection
  }
  function io(project = false) {
    return managementCli(client, project ? context : undefined)
  }
  async function guarded(work) {
    if (busy || !context.visible || !client.alive) return
    busy = true
    const current = ++revision
    try {
      await work(() => client.alive && context.visible && revision === current)
    } catch (error) {
      say(error.message)
    } finally {
      busy = false
    }
  }
  function on(id, event, work) {
    const target = element(id),
      callback = (event) => {
        event.preventDefault()
        void guarded((current) => work(event, current))
      }
    target.addEventListener(event, callback)
    listeners.push(() => target.removeEventListener(event, callback))
  }
  async function action(id, input = {}) {
    const result = await client.request('actions.invoke', { action: id, input })
    show(result)
    say(
      result.message ?? `${result.outcome ?? result.status ?? 'Result observed'} · ${id}`,
    )
    return result
  }
  function review(title, summary, plan, task) {
    prepared = {
      ...task,
      workspace: context.workspace
        ? JSON.parse(JSON.stringify(context.workspace))
        : undefined,
    }
    element('review-title').textContent = title
    element('review-summary').textContent = summary
    element('review-plan').textContent = JSON.stringify(plan, null, 2)
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
  on('observe-library', 'click', async (_event, current) => {
    const value = await io().run(['library', 'status', '--json'])
    if (!current()) return
    show(value)
    if (value.schema !== 'skillager.library-status.v1')
      throw new Error('Supported public library status is unavailable')
    observed = value.initialized ? registeredLibrary(value) : undefined
    element('connect-library').disabled = !observed
    element('library-identity').textContent = observed
      ? `${observed.root.hostId}: ${observed.root.path} · ${observed.id} · history ${observed.gitMode} · observed; choose Connect`
      : 'No registered personal library. Choose an explicit location and history for a new library.'
    say('Public library status observed; browsing and reading remain independent')
  })
  on('connect-library', 'click', async (_event, current) => {
    if (!observed) throw new Error('Observe a registered library first')
    const chosen = observed,
      fresh = registeredLibrary(await io().run(['library', 'status', '--json']))
    sameLibrary(chosen, fresh)
    if (chosen.gitMode !== fresh.gitMode)
      throw new Error('Observed history mode changed. Observe and choose Connect again.')
    if (!current()) return
    connection = fresh
    source = undefined
    clearPlan()
    element('library-identity').textContent =
      `Connected ${fresh.root.hostId}: ${fresh.root.path} · ${fresh.id} · history ${fresh.gitMode}`
    say(
      'Management connected to the observed library. Select a source or preview approved-source sync.',
    )
  })
  on('initialize', 'submit', async (_event, current) => {
    const selection = {
      root: absoluteLocalPath(element('library-path').value),
      git: element('git-history').checked,
    }
    const result = await action('initialize-library', selection)
    if (!current() || result.outcome !== 'verified') return
    observed = result.observed
    connection = result.connect ? result.observed : undefined
    element('connect-library').disabled = false
    element('library-identity').textContent =
      `${result.connect ? 'Connected' : 'Observed; explicitly choose Connect'} ${observed.root.hostId}: ${observed.root.path} · ${observed.id} · history ${observed.gitMode}`
    say(`${result.message}. ${result.guidance}`)
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
  on('observe-source', 'click', async (_event, current) => {
    const library = connected(),
      id = element('skill-id').value.trim(),
      value = await io().run(['library', 'status', id, '--json'])
    const selected = acceptedSource(value, library, id)
    if (!current()) return
    source = selected
    clearPlan()
    show(value)
    element('source-identity').textContent =
      `Selected ${selected.id} · accepted hash ${selected.hash}. Add uses this exact version in the displayed destination.`
    say(
      'Accepted source version selected. The public exposure plan still determines eligibility.',
    )
  })
  function copyInput() {
    if (!source || source.id !== element('skill-id').value.trim())
      throw new Error('Select the current accepted source version explicitly')
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
                  action: remove ? 'remove-copy' : 'update-copy',
                  input: { ...input, token: prepared.plan.token },
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
    if (
      task.action === 'update-copy' &&
      task.input.skillId !== element('skill-id').value.trim()
    )
      throw new Error(
        'The selected source changed. Select and review its current version again.',
      )
    clearPlan()
    await action(task.action, task.input)
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
      button.addEventListener(
        'click',
        () =>
          void guarded(async (current) => {
            let report = '',
              offset = 0
            for (;;) {
              const page = await client.request('actions.invoke', {
                action: 'operation-state',
                input: { mode: 'report', operationId: id, offset },
              })
              report += page.data
              if (report.length > 2 * 256 * 1024 + 8192)
                throw new Error(
                  'Complete operation report exceeds its bounded lifetime storage',
                )
              if (page.nextOffset === null) break
              if (page.nextOffset <= offset)
                throw new Error('Operation report page did not advance')
              offset = page.nextOffset
            }
            if (!current()) return
            element('operation-report').textContent = report
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
  for (const id of ['copy-agent', 'copy-mode'])
    on(id, 'change', () => {
      clearPlan()
    })
  const unlisten = client.listen((message) => {
    if (message.kind !== 'context') return
    if (JSON.stringify(message.context.workspace) !== JSON.stringify(context.workspace)) {
      clearPlan()
      element('managed-copies').replaceChildren()
      revision++
    }
    if (!message.context.visible) revision++
    context = message.context
    const row = context.input?.row
    if (
      row?.source === 'library' &&
      typeof row.id === 'string' &&
      row.id !== element('skill-id').value.trim()
    ) {
      clearSource()
      element('skill-id').value = row.id
    }
    element('destination').textContent = context.workspace?.root
      ? `${context.workspace.host}: ${context.workspace.root.path} · exact selected workspace ${context.workspace.id}`
      : 'Personal library · open this view from a local project for copies and terminal setup.'
  })
  const exactReview = bindExactReview(document, client, {
    context: () => context,
    library: connected,
    say,
    action,
  })
  return {
    dispose() {
      exactReview.dispose()
      unlisten()
      for (const release of listeners) release()
      revision++
    },
  }
}
