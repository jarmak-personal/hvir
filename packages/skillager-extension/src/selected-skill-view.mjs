import { mountSkillTasks } from './skill-task-template.mjs'
import { bindSelectedImport } from './import-view.mjs'
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
  mountSkillTasks(document)
  const el = (id) => document.getElementById(id)
  let selection,
    library,
    source,
    installed,
    prepared,
    pending = [],
    busy = false,
    activeAction = false,
    connecting,
    ready = false,
    projectReady = false,
    refreshQueued = false,
    serial = 0,
    selectionRevision = 0,
    terminalMessage,
    importSelected = false,
    disposed = false,
    requestedTask,
    importBusy = false
  const context = ports.context
  const importing = bindSelectedImport(document, client, {
    context,
    useLibrary: () => chooseImport(false),
    changed: ports.changed,
    activity: (value) => {
      importBusy = value
      ports.activity?.(activeAction || importBusy)
    },
  })
  const skillId = () =>
    selection?.row.canonical?.skill_id ??
    (selection?.row.source === 'library' ? selection.row.id : undefined)
  const exposure = () =>
    selection?.row.source === 'project' ? selection.row.exposure : undefined
  const agent = () => exposure()?.agent ?? el('task-agent').value
  const say = (message) => {
    el('task-state').textContent = message
  }
  const current = (revision) =>
    !disposed &&
    !importSelected &&
    client.alive &&
    context().visible &&
    serial === revision
  const review = bindExactReview(document, client, {
    context,
    library: () => library,
    skillId,
    say: (message) => {
      if (message) say(message)
    },
    action: (id, input) => invoke(id, input),
    accepted: () => {
      void refresh()
    },
  })
  const taskKey = () =>
    JSON.stringify([
      selection?.library?.id ?? selection?.row.canonical?.library_id,
      skillId(),
      context().workspace?.id,
      context().workspace?.root,
      agent(),
      exposure()?.exposure_id,
      exposure()?.target,
    ])
  // Submitted results belong to the exact selection, independently of preview authority.
  function retainedSelection() {
    const selected = selection,
      revision = selectionRevision,
      key = taskKey()
    return () =>
      !disposed &&
      client.alive &&
      !importSelected &&
      selection === selected &&
      selectionRevision === revision &&
      taskKey() === key
  }
  function terminal(message) {
    terminalMessage = message
    say(message)
  }
  const remote = () => !!context().workspace && context().workspace.host !== 'local'
  const unchanged = () =>
    ['current', 'recorded'].includes(installed?.status) &&
    installed.sourceHash === source?.hash
  function controls() {
    if (disposed) return
    ports.activity?.(activeAction || importBusy)
    const local = localWorkspace(context().workspace),
      workspace = context().workspace,
      working = busy || activeAction
    el('task-destination').textContent = workspace
      ? `${workspace.name} · ${workspace.host}`
      : 'Choose a project above to add this skill.'
    el('task-destination').title = workspace
      ? `${workspace.host}: ${workspace.root?.path ?? 'Path unavailable'}`
      : ''
    el('task-primary').textContent = source
      ? installed
        ? unchanged()
          ? remote()
            ? 'Recorded'
            : 'Added'
          : 'Update'
        : 'Add to project'
      : 'Review version'
    el('task-primary').hidden =
      !source ||
      (!!installed && unchanged()) ||
      (!!exposure() && !installed) ||
      !!prepared
    el('task-primary').disabled =
      working ||
      !source ||
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
    el('task-agent-field').hidden = !!exposure()
    el('task-agent-name').hidden = !exposure()
    el('task-agent-name').textContent = exposure()?.agent ?? ''
    el('task-agent').disabled = working || !!exposure()
    el('task-mode').disabled =
      working ||
      !ready ||
      !!prepared ||
      pending.length > 0 ||
      remote() ||
      (!!installed && !source)
    if (installed) el('task-mode').value = installed.mode
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
    el('task-save-original').hidden = !local || selection?.row.kind !== 'Project original'
    el('task-save-original').disabled = working
  }
  function chooseImport(selected, options) {
    if (busy || activeAction) return
    importSelected = selected
    invalidate()
    el('selected-task').hidden = selected || !skillId()
    el('task-options').open = false
    const preparation = importing.select(selected ? selection : undefined, options)
    if (!selected && skillId()) void refresh()
    return preparation
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
        agent(),
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
          item.agent === agent() &&
          item.scope === 'project' &&
          ['native', 'stub'].includes(item.mode) &&
          (!exposure() ||
            (item.exposure_id === exposure().exposure_id &&
              item.target === exposure().target)),
      )
      if (matches.length > 1)
        throw new Error(
          'More than one managed copy matches. Choose the exact copy in advanced management.',
        )
      if (!current(revision)) return
      installed = matches[0]
      if (exposure() && !installed)
        throw new Error(
          'The selected project copy is no longer available. Refresh Project skills.',
        )
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
      agent: agent(),
      ...(installed || exposure()
        ? {
            target: {
              hostId: context().workspace.host,
              path: installed?.target ?? exposure().target,
            },
          }
        : {}),
    }
  }
  async function refresh() {
    if (importSelected) return
    if (busy || activeAction) {
      refreshQueued = true
      return
    }
    refreshQueued = false
    ready = false
    projectReady = false
    return guarded(async (revision) => {
      if (!skillId()) return
      if (
        selection.row.source === 'project' &&
        (selection.row.workspaceId !== context().workspace?.id ||
          selection.row.host !== context().workspace?.host)
      )
        throw new Error(
          'This skill belongs to a different project. Select it in its original project.',
        )
      if (terminalMessage === undefined) say('Checking this skill…')
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
      let deliveryPending
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
            agent: agent(),
          })
          if (!current(revision)) return
          installed = observation.installed
          deliveryPending = observation.pending
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
      pending = [
        ...(deliveryPending ??
          (remote()
            ? pending.filter((entry) => typeof entry.operation === 'string')
            : [])),
        ...observedPending,
      ]
      if (current(revision)) {
        if (installed) el('task-mode').value = installed.mode
        ready = true
        say(
          projectIssue ??
            terminalMessage ??
            (pending.length
              ? remote() && !pending[0]?.id
                ? 'Delivery recovery needs attention for this exact target. Inspect its recorded operations before trying again.'
                : 'This operation has an uncertain outcome. Inspect it before trying again.'
              : remote()
                ? installed
                  ? 'Full copy recorded · remote state has not been verified.'
                  : source
                    ? 'Choose a local export folder to review Full delivery.'
                    : ''
                : ''),
        )
        if (
          terminalMessage === undefined &&
          !source &&
          !pending.length &&
          requestedTask !== 'remove'
        )
          await review.start()
      }
    })
  }
  function copyInput(remove = false, mode = el('task-mode').value) {
    if (!library || (!remove && !source))
      throw new Error('Review and accept the current version first')
    return {
      library,
      agent: agent(),
      ...(remove ? {} : { skillId: source.id, hash: source.hash, mode }),
      ...(installed
        ? {
            exposureId: installed.exposure_id,
            target: { hostId: 'local', path: installed.target },
          }
        : {}),
    }
  }
  async function invoke(action, input) {
    const revision = serial,
      origin = context().workspace,
      retained = retainedSelection()
    terminalMessage = undefined
    let result
    activeAction = true
    controls()
    try {
      result = await client.request('actions.invoke', { action, input })
    } catch (error) {
      if (retained()) {
        terminal(error.message)
        refreshQueued = true
      }
      ports.changed?.(undefined, origin, error)
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
    ports.changed?.(result, origin)
    if (!retained()) return result
    if (result?.outcome === 'uncertain' || !current(revision)) {
      if (busy) refreshQueued = true
      else void refresh()
    }
    terminal(
      result?.outcome === 'verified'
        ? result.restartRequired
          ? 'Restart your agent to use the change.'
          : ''
        : (result?.message ??
            result?.reason ??
            'The operation could not be verified. Inspect it before trying again.'),
    )
    el('task-result').textContent = JSON.stringify(result, null, 2)
    controls()
    return result
  }
  async function prepare(remove, revision, requestedMode = el('task-mode').value) {
    terminalMessage = undefined
    if (remote()) {
      const input = {
        library,
        skillId: skillId(),
        hash: source?.hash ?? installed?.sourceHash,
        agent: agent(),
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
    const input = copyInput(remove, requestedMode)
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
      requestedMode,
    }
    el('task-confirm-title').textContent = remove
      ? 'Remove from this project?'
      : installed.mode !== requestedMode
        ? `Change to ${requestedMode === 'stub' ? 'Stub' : 'Full copy'}?`
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
  on('task-save-original', 'click', () => chooseImport(true))
  on('task-primary', 'click', () => {
    if (!source) return
    void guarded(async (revision) => {
      if (installed || remote()) await prepare(false, revision)
      else {
        const input = copyInput(),
          retained = retainedSelection()
        const result = await invoke('add-copy', input)
        if (retained() && result?.outcome === 'verified') {
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
          const origin = context().workspace,
            retained = retainedSelection()
          terminalMessage = undefined
          activeAction = true
          controls()
          try {
            const result = await applyPreparedDelivery(
              scopedClient(revision),
              task.delivery,
            )
            ports.changed?.(result, origin)
            if (retained()) {
              el('task-result').textContent = JSON.stringify(result, null, 2)
              terminal(result.message)
              el('task-export').value = ''
              refreshQueued = true
            }
          } catch (error) {
            if (retained()) {
              terminal(error.message)
              refreshQueued = true
            }
            ports.changed?.(undefined, origin, error)
            throw error
          } finally {
            activeAction = false
            controls()
          }
          return
        }
        const retained = retainedSelection()
        const result = await invoke(task.action, task.input)
        if (!retained()) return
        if (task.action === 'operation-state') {
          refreshQueued = true
          return
        }
        if (result?.outcome === 'verified' && task.action === 'remove-copy')
          installed = undefined
        else if (result?.outcome === 'verified')
          installed = {
            ...installed,
            mode: task.requestedMode,
            sourceHash: source.hash,
            status: 'current',
          }
      }),
  )
  on('task-cancel', 'click', clearPrepared)
  on('task-export', 'input', clearPrepared)
  on('task-agent', 'change', () => {
    if (exposure()) return
    invalidate()
    void refresh()
  })
  on('task-mode', 'change', () => {
    const requestedMode = el('task-mode').value
    if (!installed) {
      clearPrepared()
      return
    }
    el('task-mode').value = installed.mode
    if (requestedMode === installed.mode) return
    clearPrepared()
    void guarded((revision) => prepare(false, revision, requestedMode))
  })
  on('task-refresh', 'click', () => {
    terminalMessage = undefined
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
    preserved: (value) => importing.preserved(value),
    saveAndUse(mode) {
      return chooseImport(true, { mode })
    },
    async select(input, options = {}) {
      selectionRevision++
      terminalMessage = undefined
      invalidate()
      el('task-result').textContent = ''
      el('task-operation-details').open = false
      selection = input
      requestedTask = options.task
      const revision = serial
      importSelected =
        selection?.row.kind === 'Project original' &&
        (!skillId() || options.task === 'save')
      const preparation = importing.select(importSelected ? input : undefined, {
        prepare: options.prepare,
      })
      if (!exposure()) el('task-mode').value = 'native'
      library = source = installed = undefined
      pending = []
      el('selected-task').hidden = importSelected || !skillId()
      if (importSelected) await preparation
      if (!importSelected && skillId()) {
        await refresh()
        if (
          !current(revision) ||
          selection !== input ||
          !ready ||
          !projectReady ||
          pending.length
        )
          return
        if (options.task === 'remove' && installed)
          await guarded((active) => prepare(true, active))
        else if (['native', 'stub'].includes(options.task)) {
          if (installed && source && installed.mode !== options.task)
            await guarded((active) => prepare(false, active, options.task))
          else if (!installed) el('task-mode').value = options.task
        }
      }
    },
    contextChanged() {
      importing.contextChanged()
      if (connecting?.revision === serial && connecting.key === taskKey()) {
        controls()
        return
      }
      selectionRevision++
      terminalMessage = undefined
      invalidate()
      el('task-result').textContent = ''
      el('task-operation-details').open = false
      source = installed = undefined
      pending = []
      if (selection && context().visible) void refresh()
      controls()
    },
    visibilityChanged({ completed = false } = {}) {
      if (!completed) importing.visibilityChanged()
      invalidate()
      if (!importSelected && selection && context().visible) void refresh()
      controls()
    },
    dispose() {
      if (disposed) return
      disposed = true
      invalidate()
      review.dispose()
      importing.dispose()
    },
  }
}
