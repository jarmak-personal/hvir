import { managementCli } from './management-cli.mjs'
import { registeredLibrary, acceptedSource, sameLibrary } from './management-contract.mjs'
import { localWorkspace } from './catalog.mjs'
import { prepareCopy } from './management-copy.mjs'
import { copyChangeInput } from './exposure-operation.mjs'
import { bindExactReview } from './review-view.mjs'
import { selectedPendingOperations } from './operation-report.mjs'
import { selectedDelivery } from './selected-delivery.mjs'
import { prepareDelivery, applyPreparedDelivery } from './delivery-operation.mjs'

/** Selected-skill task composition. Public CLI owners retain all mutation policy. */
export function bindSelectedSkill(document, client, ports) {
  const el = (id) => document.getElementById(id)
  let selection,
    library,
    source,
    installed,
    prepared,
    pending = [],
    modeKey,
    chosenMode = false,
    busy = false,
    activeAction = false,
    connecting,
    ready = false,
    projectReady = false,
    refreshQueued = false,
    serial = 0
  const context = ports.context
  const skillId = () =>
    selection?.row.canonical?.skill_id ??
    (selection?.row.source === 'library' ? selection.row.id : undefined)
  const say = (message) => {
    el('task-state').textContent = message
  }
  const current = (revision) => client.alive && context().visible && serial === revision
  const review = bindExactReview(document, client, {
    context,
    library: () => library,
    skillId,
    say,
    action: (id, input) => invoke(id, input),
    accepted: () => {
      void refresh('Version accepted.')
    },
  })
  const taskKey = () =>
    JSON.stringify([
      selection?.library?.id ?? selection?.row.canonical?.library_id,
      skillId(),
      context().workspace?.id,
      context().workspace?.root,
      el('task-agent').value,
    ])
  const remote = () => !!context().workspace && context().workspace.host !== 'local'
  const unchanged = () =>
    ['current', 'recorded'].includes(installed?.status) &&
    installed.sourceHash === source?.hash &&
    installed.mode === el('task-mode').value
  function controls() {
    const local = localWorkspace(context().workspace),
      workspace = context().workspace,
      working = busy || activeAction
    el('task-destination').textContent = workspace
      ? `${workspace.name} · ${workspace.host}: ${workspace.root?.path ?? 'Path unavailable'}`
      : 'Choose a project above to add this skill.'
    el('task-primary').textContent = source
      ? installed
        ? unchanged()
          ? remote()
            ? 'Recorded'
            : 'Added'
          : 'Update'
        : 'Add to project'
      : 'Review version'
    el('task-primary').disabled =
      working ||
      !ready ||
      !context().visible ||
      !!prepared ||
      pending.length > 0 ||
      !library ||
      (!!source && (!workspace || !projectReady || unchanged()))
    el('task-update').hidden = !remote() || !installed
    el('task-update').disabled =
      working || !ready || !projectReady || !!prepared || pending.length > 0 || !source
    el('task-remove').hidden = !installed
    el('task-remove').disabled =
      working ||
      !ready ||
      !projectReady ||
      !context().visible ||
      !!prepared ||
      pending.length > 0
    el('task-agent').disabled = working
    el('task-mode').disabled = working || pending.length > 0 || remote()
    el('task-export-field').hidden = !remote()
    el('task-export').disabled = working
    if (remote()) el('task-mode').value = 'native'
    el('task-connect').hidden = !local || !el('task-connect').dataset.needed
    el('task-connect').disabled = working
    el('task-refresh').disabled = working
    el('task-reconcile').hidden = !pending.length
    el('task-reconcile').textContent =
      remote() && !pending[0]?.id
        ? 'Inspect delivery recovery'
        : 'Inspect uncertain operation'
    el('task-options').hidden = !library
  }
  function invalidate() {
    serial++
    ready = false
    clearPrepared()
    review.invalidate()
  }
  function scopedClient(revision) {
    return {
      get alive() {
        return current(revision)
      },
      get visible() {
        return context().visible
      },
      request: (...args) => {
        if (
          !(
            ['connector.output', 'delivery.manifest'].includes(args[0]) &&
            args[1]?.release
          ) &&
          !current(revision)
        )
          throw new Error('Selected skill or destination changed')
        return client.request(...args)
      },
      delay: (ms) => client.delay(ms),
    }
  }
  function io(project, revision) {
    return managementCli(scopedClient(revision), project ? context() : undefined)
  }
  function clearPrepared() {
    const previous = prepared
    prepared = undefined
    el('task-confirmation').hidden = true
    controls()
    if (previous?.delivery?.capture)
      void client
        .request('delivery.manifest', {
          receipt: previous.delivery.capture,
          release: true,
        })
        .catch(() => {})
  }
  async function guarded(work) {
    if (busy || activeAction || !client.alive || !context().visible) return
    busy = true
    controls()
    const revision = serial
    try {
      await work(revision)
    } catch (error) {
      if (current(revision)) say(error.message)
    } finally {
      busy = false
      controls()
      if (refreshQueued && context().visible && client.alive) {
        refreshQueued = false
        void refresh()
      }
    }
  }
  async function observeProject(revision) {
    try {
      const connections = await scopedClient(revision).request('connector.status', {
          workspace: context().workspace?.id,
        }),
        connection = connections.find(
          (entry) =>
            entry.connector === 'project-cli' && entry.host === context().workspace?.host,
        )
      if (connection?.availability !== 'supported') {
        if (connection?.availability === 'unavailable')
          el('task-connect').dataset.needed = 'true'
        else delete el('task-connect').dataset.needed
        return (
          connection?.explanation ??
          'Connect Skillager for this project to manage its copies.'
        )
      }
      delete el('task-connect').dataset.needed
      const value = await io(true, revision).run([
        'expose',
        '--list',
        '--agent',
        el('task-agent').value,
        '--scope',
        'project',
        '--json',
      ])
      if (value.schema !== 'skillager.exposures.v1' || !Array.isArray(value.exposures))
        throw new Error('Installed copy status is unavailable')
      const matches = value.exposures.filter(
        (item) =>
          item.skill_id === skillId() &&
          item.source_library_id === library.id &&
          item.agent === el('task-agent').value &&
          item.scope === 'project' &&
          ['native', 'stub'].includes(item.mode),
      )
      if (matches.length > 1)
        throw new Error(
          'More than one managed copy matches. Choose the exact copy in advanced management.',
        )
      if (!current(revision)) return
      installed = matches[0]
      if (installed) {
        // Public library status reports exposures for its project directory.
        // Read that binding in the same exact project scope as expose --list.
        const projectStatus = await io(true, revision).run([
          'library',
          'status',
          skillId(),
          '--json',
        ])
        sameLibrary(library, registeredLibrary(projectStatus))
        if (
          projectStatus.skill?.id !== skillId() ||
          (selection.row.source === 'library' &&
            projectStatus.skill.entrypoint !== selection.row.path)
        )
          throw new Error(
            'The selected source changed. Select its current occurrence from your library.',
          )
        if (!current(revision)) return
        source =
          projectStatus.skill.acceptance === 'accepted' &&
          projectStatus.skill.accepted_hash === projectStatus.skill.working_hash
            ? acceptedSource(projectStatus, library, skillId())
            : undefined
        installed = {
          ...installed,
          sourceHash: projectStatus.skill.exposures?.find(
            (entry) =>
              entry.path === installed.target &&
              entry.agent === installed.agent &&
              entry.scope === 'project' &&
              entry.source_library_id === library.id,
          )?.source_hash,
        }
      }
      const scopes = await scopedClient(revision).request('source.status', {})
      if (!current(revision)) return
      const readable = scopes.some((entry) => entry.source === 'project' && entry.granted)
      if (readable) delete el('task-connect').dataset.needed
      else el('task-connect').dataset.needed = 'true'
      projectReady = true
      if (!readable)
        return 'Project read access is not connected. Choose Connect Skillager to read selected project files.'
    } catch (error) {
      if (!current(revision)) return
      if (['missing-program', 'program-updated'].includes(error.setupState)) {
        el('task-connect').dataset.needed = 'true'
        return error.setupState === 'program-updated'
          ? 'Skillager was updated. Choose Connect Skillager to review its program access.'
          : 'Connect Skillager for this project to see and manage its installed copies.'
      }
      return error.message
    }
  }
  function pendingSelection() {
    return {
      library,
      skillId: skillId(),
      workspace: context().workspace,
      agent: el('task-agent').value,
      ...(installed
        ? { target: { hostId: context().workspace.host, path: installed.target } }
        : {}),
    }
  }
  async function refresh(message) {
    if (busy || activeAction) {
      refreshQueued = true
      return
    }
    ready = false
    projectReady = false
    pending = []
    if (modeKey !== taskKey()) {
      modeKey = taskKey()
      chosenMode = false
    }
    return guarded(async (revision) => {
      if (!skillId()) return
      say('Checking this skill…')
      const status = await io(false, revision).run([
        'library',
        'status',
        skillId(),
        '--json',
      ])
      const observed = registeredLibrary(status)
      const identity =
        selection.library ??
        (selection.row.canonical ? { id: selection.row.canonical.library_id } : undefined)
      if (
        !identity ||
        identity.id !== observed.id ||
        (selection.row.canonical && selection.row.canonical.library_id !== observed.id) ||
        (identity.root && identity.root !== observed.root.path)
      )
        throw new Error(
          'This selection belongs to a different library. Select it again from your library.',
        )
      if (
        status.skill?.id !== skillId() ||
        status.skill.status === 'missing' ||
        (selection.row.source === 'library' &&
          status.skill.entrypoint !== selection.row.path)
      )
        throw new Error(
          'The selected source moved or is unavailable. Select its current occurrence from your library.',
        )
      if (library) sameLibrary(library, observed)
      if (!current(revision)) return
      library = observed
      source =
        status.skill.acceptance === 'accepted' &&
        status.skill.accepted_hash === status.skill.working_hash
          ? acceptedSource(status, library, skillId())
          : undefined
      installed = undefined
      let projectIssue = localWorkspace(context().workspace)
        ? await observeProject(revision)
        : undefined
      if (!current(revision)) return
      if (remote()) {
        try {
          const observation = await selectedDelivery(scopedClient(revision), {
            library,
            skillId: skillId(),
            workspace: context().workspace,
            agent: el('task-agent').value,
          })
          if (!current(revision)) return
          installed = observation.installed
          pending = observation.pending
          projectReady = true
        } catch (error) {
          if (!current(revision)) return
          projectIssue = error.message
        }
      }
      const observedPending = await selectedPendingOperations(
        scopedClient(revision),
        pendingSelection(),
      )
      if (!current(revision)) return
      pending.push(...observedPending)
      if (current(revision)) {
        if (installed && !chosenMode) el('task-mode').value = installed.mode
        ready = true
        say(
          pending.length
            ? remote() && !pending[0]?.id
              ? 'Delivery recovery needs attention for this exact target. Inspect its recorded operations before trying again.'
              : 'This operation has an uncertain outcome. Inspect it before trying again.'
            : message
              ? `${message} ${projectIssue ?? (!context().workspace ? 'Choose a project above to add this skill.' : !installed && source ? 'Ready to add.' : '')}`.trim()
              : (projectIssue ??
                (installed
                  ? remote()
                    ? 'Full copy recorded · remote state has not been verified.'
                    : `In this project · ${installed.mode === 'stub' ? 'Stub' : 'Full copy'} · ${installed.status}`
                  : source
                    ? !context().workspace
                      ? 'Version accepted'
                      : remote()
                        ? 'Full delivery · choose an empty or new local export folder, then review every file before adding.'
                        : 'Ready to add'
                    : 'This version needs your acceptance before adding.')),
        )
      }
    })
  }
  function copyInput(remove = false) {
    if (!library || (!remove && !source))
      throw new Error('Review and accept the current version first')
    return {
      library,
      agent: el('task-agent').value,
      ...(remove
        ? {}
        : { skillId: source.id, hash: source.hash, mode: el('task-mode').value }),
      ...(installed
        ? {
            exposureId: installed.exposure_id,
            target: { hostId: 'local', path: installed.target },
          }
        : {}),
    }
  }
  async function invoke(action, input) {
    const revision = serial
    let result
    activeAction = true
    controls()
    try {
      result = await client.request('actions.invoke', { action, input })
    } catch (error) {
      if (current(revision) && library) {
        try {
          const observed = await selectedPendingOperations(
            scopedClient(revision),
            pendingSelection(),
          )
          if (current(revision))
            pending = [
              ...pending.filter((entry) => typeof entry.operation === 'string'),
              ...observed,
            ]
        } catch (observationError) {
          if (current(revision)) ready = false
          throw new Error(
            `${error.message} Operation status could not be refreshed: ${observationError.message}`,
            { cause: observationError },
          )
        }
      }
      throw error
    } finally {
      activeAction = false
      controls()
      if (!busy && refreshQueued && context().visible && client.alive) {
        refreshQueued = false
        void refresh()
      }
    }
    if (!current(revision)) return result
    if (result?.outcome === 'uncertain') {
      if (busy) refreshQueued = true
      else void refresh()
    }
    say(
      result?.outcome === 'verified'
        ? `${action === 'accept-version' ? 'Version accepted' : action === 'remove-copy' ? 'Removed from this project' : action === 'add-copy' ? 'Added to this project' : 'Project copy updated'}${result.restartRequired ? ' · Restart your agent to use the change.' : ''}`
        : (result?.message ??
            result?.reason ??
            'The operation could not be verified. Inspect it before trying again.'),
    )
    el('task-result').textContent = JSON.stringify(result, null, 2)
    controls()
    return result
  }
  async function prepare(remove, revision) {
    if (remote()) {
      const input = {
        library,
        skillId: skillId(),
        hash: source?.hash ?? installed?.sourceHash,
        agent: el('task-agent').value,
        mode: 'native',
        exportDirectory: el('task-export').value.trim(),
        ...(installed
          ? {
              record: installed.record,
              target: { hostId: context().workspace.host, path: installed.target },
            }
          : {}),
      }
      const delivery = await prepareDelivery(
        scopedClient(revision),
        input,
        context().workspace,
        remove ? 'remove' : installed ? 'update' : 'add',
      )
      if (!current(revision)) {
        if (delivery.capture)
          await client
            .request('delivery.manifest', { receipt: delivery.capture, release: true })
            .catch(() => {})
        return
      }
      prepared = { delivery, revision }
      el('task-confirm-title').textContent = `Review Full ${delivery.kind}`
      el('task-confirm-target').textContent =
        `${context().workspace.host}: ${delivery.preview.target.path}. ${delivery.disclosure}`
      el('task-effects').replaceChildren(
        ...delivery.entries.map((entry) => {
          const row = document.createElement('li')
          row.textContent = `${entry.path || '.'} · ${entry.type} · mode ${entry.mode.toString(8)}`
          return row
        }),
      )
      el('task-plan').textContent = JSON.stringify(
        {
          ...delivery.preview,
          files: delivery.entries,
          requirements: delivery.requirements,
          localExport: delivery.localExport,
        },
        null,
        2,
      )
      el('task-confirm').textContent = remove
        ? 'Remove'
        : installed
          ? 'Update'
          : 'Add to project'
      el('task-confirmation').hidden = false
      return
    }
    const input = copyInput(remove)
    const value = await prepareCopy(
      io(true, revision),
      input,
      localWorkspace(context().workspace),
      remove,
    )
    if (!current(revision)) return
    prepared = {
      action: remove ? 'remove-copy' : 'change-exposure',
      input: remove
        ? { ...input, token: value.plan.token }
        : copyChangeInput({ ...input, token: value.plan.token }),
      revision,
    }
    el('task-confirm-title').textContent = remove
      ? 'Remove from this project?'
      : 'Update this project copy?'
    el('task-confirm-target').textContent = `${input.agent} · local: ${value.plan.target}`
    el('task-effects').replaceChildren(
      ...value.plan.preview.file_effects.map((effect) => {
        const row = document.createElement('li')
        row.textContent = `${effect.action} · ${effect.path}`
        return row
      }),
    )
    el('task-plan').textContent = JSON.stringify(value.plan.preview, null, 2)
    el('task-confirm').textContent = remove ? 'Remove' : 'Update'
    el('task-confirmation').hidden = false
  }
  const on = (id, event, work) =>
    el(id)?.addEventListener(event, work, { signal: client.signal })
  on('task-primary', 'click', () => {
    if (!source) {
      void review.start()
      return
    }
    void guarded(async (revision) => {
      if (installed || remote()) await prepare(false, revision)
      else {
        const input = copyInput()
        const result = await invoke('add-copy', input)
        if (current(revision) && result?.outcome === 'verified') {
          installed = {
            exposure_id: result.exposureId,
            target: result.target.path,
            mode: input.mode,
            status: 'current',
            sourceHash: input.hash,
          }
        }
      }
    })
  })
  on('task-update', 'click', () => void guarded((revision) => prepare(false, revision)))
  on('task-remove', 'click', () => void guarded((revision) => prepare(true, revision)))
  on(
    'task-confirm',
    'click',
    () =>
      void guarded(async (revision) => {
        const task = prepared
        if (!task || task.revision !== revision) return
        prepared = undefined
        el('task-confirmation').hidden = true
        if (task.delivery) {
          const result = await applyPreparedDelivery(
            scopedClient(revision),
            task.delivery,
          )
          if (current(revision)) {
            el('task-result').textContent = JSON.stringify(result, null, 2)
            say(result.message)
            el('task-export').value = ''
            refreshQueued = true
          }
          return
        }
        const result = await invoke(task.action, task.input)
        if (task.action === 'operation-state') {
          refreshQueued = true
          return
        }
        if (
          current(revision) &&
          result?.outcome === 'verified' &&
          task.action === 'remove-copy'
        )
          installed = undefined
        else if (current(revision) && result?.outcome === 'verified')
          installed = {
            ...installed,
            mode: el('task-mode').value,
            sourceHash: source.hash,
            status: 'current',
          }
      }),
  )
  on('task-cancel', 'click', clearPrepared)
  on('task-export', 'input', clearPrepared)
  for (const id of ['task-agent', 'task-mode'])
    on(id, 'change', () => {
      if (id === 'task-mode') chosenMode = true
      invalidate()
      void refresh()
    })
  on('task-refresh', 'click', () => {
    invalidate()
    void refresh()
  })
  on(
    'task-connect',
    'click',
    () =>
      void guarded(async (revision) => {
        connecting = { revision, key: taskKey() }
        say('Connecting Skillager…')
        try {
          const result = await client.request('connector.connect', {
            connector: 'project-cli',
            source: 'project',
          })
          if (current(revision)) {
            if (
              result.connections?.some(
                (entry) =>
                  entry.connector === 'project-cli' && entry.outcome === 'connected',
              ) &&
              result.source?.outcome === 'granted' &&
              result.readiness?.program === true &&
              result.readiness?.source === true
            )
              refreshQueued = true
            else
              say(
                result.connections?.some(
                  (entry) =>
                    entry.connector === 'project-cli' && entry.outcome === 'connected',
                )
                  ? result.readiness?.program === true
                    ? 'The program is connected. Project read access was not confirmed. Choose Connect Skillager when ready.'
                    : result.readiness?.program === false
                      ? 'Program access was saved but is no longer ready. Choose Connect Skillager to check the remaining access.'
                      : 'Connection ended before access could be confirmed. Choose Connect Skillager to check again.'
                  : (result.connections?.[0]?.explanation ??
                      'Connection was not completed.'),
              )
          }
        } finally {
          connecting = undefined
        }
      }),
  )
  on(
    'task-reconcile',
    'click',
    () =>
      void guarded(async (revision) => {
        if (remote() && !pending[0]?.id) {
          el('task-result').textContent = JSON.stringify(pending, null, 2)
          el('task-operation-details').open = true
          say(
            'Inspect these exact recorded operations in Settings → Extensions → Delivery recovery. No delivery is replayed.',
          )
          return
        }
        const operationId = pending[0]?.id
        if (!operationId) return
        const result = await client.request('actions.invoke', {
          action: 'operation-state',
          input: { mode: 'observe', operationId },
        })
        if (!current(revision)) return
        el('task-result').textContent = JSON.stringify(
          { record: pending[0], ...result },
          null,
          2,
        )
        el('task-operation-details').open = true
        say(
          result.message ??
            'Current facts observed. Original completion remains unknown.',
        )
        if (result.outcome === 'observed') {
          prepared = {
            action: 'operation-state',
            input: { mode: 'acknowledge', operationId, observation: result.observation },
            revision,
          }
          el('task-confirm-title').textContent = 'Acknowledge these current facts?'
          el('task-confirm-target').textContent = result.message
          el('task-effects').replaceChildren()
          el('task-plan').textContent = result.observation
          el('task-confirm').textContent = 'Acknowledge'
          el('task-confirmation').hidden = false
        }
      }),
  )
  return {
    select(input) {
      invalidate()
      el('task-result').textContent = ''
      el('task-operation-details').open = false
      selection = input
      chosenMode = false
      library = source = installed = undefined
      pending = []
      el('selected-task').hidden = !skillId()
      if (skillId()) void refresh()
    },
    contextChanged() {
      if (connecting?.revision === serial && connecting.key === taskKey()) {
        controls()
        return
      }
      invalidate()
      el('task-result').textContent = ''
      el('task-operation-details').open = false
      source = installed = undefined
      if (selection && context().visible) void refresh()
      controls()
    },
    dispose() {
      invalidate()
      review.dispose()
    },
  }
}
