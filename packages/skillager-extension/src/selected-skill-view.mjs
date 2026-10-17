import { managementCli } from './management-cli.mjs'
import { registeredLibrary, acceptedSource, sameLibrary } from './management-contract.mjs'
import { localWorkspace } from './catalog.mjs'
import { prepareCopy } from './management-copy.mjs'
import { copyChangeInput } from './exposure-operation.mjs'
import { bindExactReview } from './review-view.mjs'

/** Selected-skill task composition. Public CLI owners retain all mutation policy. */
export function bindSelectedSkill(document, client, ports) {
  const el = (id) => document.getElementById(id)
  let selection,
    library,
    source,
    installed,
    prepared,
    pending,
    busy = false,
    activeAction = false,
    ready = false,
    refreshQueued = false,
    serial = 0
  const uncertain = new Map()
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
      void refresh('Version accepted. Choose Add to use it in this project.')
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
  const unchanged = () =>
    installed?.status === 'current' &&
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
          ? 'Added'
          : 'Update'
        : 'Add to project'
      : 'Review version'
    el('task-primary').disabled =
      working ||
      !ready ||
      !context().visible ||
      !!pending ||
      !library ||
      (!!source && (!local || unchanged()))
    el('task-remove').hidden = !installed
    el('task-remove').disabled = working || !ready || !context().visible || !!pending
    el('task-agent').disabled = working || !!pending
    el('task-mode').disabled = working || !!pending
    el('task-connect').hidden = !local || !el('task-connect').dataset.needed
    el('task-connect').disabled = working
    el('task-refresh').disabled = working
    el('task-reconcile').hidden = !pending || pending === 'unknown'
    el('task-options').hidden = !library
  }
  function invalidate() {
    serial++
    ready = false
    prepared = undefined
    el('task-confirmation').hidden = true
    review.invalidate()
  }
  function io(project, revision) {
    const scoped = {
      get alive() {
        return current(revision)
      },
      get visible() {
        return context().visible
      },
      request: (...args) => {
        if (!(args[0] === 'connector.output' && args[1]?.release) && !current(revision))
          throw new Error('Selected skill or destination changed')
        return client.request(...args)
      },
      delay: (ms) => client.delay(ms),
    }
    return managementCli(scoped, project ? context() : undefined)
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
  async function refresh(message) {
    if (busy || activeAction) {
      refreshQueued = true
      return
    }
    ready = false
    pending = uncertain.get(taskKey())
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
      if (localWorkspace(context().workspace)) {
        try {
          const value = await io(true, revision).run([
            'expose',
            '--list',
            '--agent',
            el('task-agent').value,
            '--scope',
            'project',
            '--json',
          ])
          if (
            value.schema !== 'skillager.exposures.v1' ||
            !Array.isArray(value.exposures)
          )
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
          delete el('task-connect').dataset.needed
        } catch (error) {
          if (!current(revision)) return
          if (
            /unapproved|approval|not approved|not configured|not connected|grant|connection/iu.test(
              error.message,
            )
          ) {
            el('task-connect').dataset.needed = 'true'
            say(
              'Connect Skillager for this project to see and manage its installed copies.',
            )
            return
          }
          throw error
        }
      }
      if (current(revision)) {
        ready = true
        say(
          pending
            ? 'This operation has an uncertain outcome. Inspect it before trying again.'
            : (message ??
                (installed
                  ? `In this project · ${installed.mode === 'stub' ? 'Stub' : 'Full copy'} · ${installed.status}`
                  : source
                    ? context().workspace && !localWorkspace(context().workspace)
                      ? 'Project copy management is available for local projects. Open Advanced management for remote setup.'
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
    const key = taskKey()
    let result
    activeAction = true
    controls()
    try {
      result = await client.request('actions.invoke', { action, input })
    } catch (error) {
      uncertain.set(key, 'unknown')
      if (current(revision)) {
        pending = 'unknown'
        say(
          `Completion could not be confirmed. ${error.message} Inspect advanced management before retrying.`,
        )
        controls()
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
    if (result?.outcome === 'uncertain')
      uncertain.set(key, result.operationId ?? 'unknown')
    if (!current(revision)) return result
    pending = uncertain.get(key)
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
      if (installed) await prepare(false, revision)
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
        const result = await invoke(task.action, task.input)
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
  on('task-cancel', 'click', () => {
    prepared = undefined
    el('task-confirmation').hidden = true
  })
  for (const id of ['task-agent', 'task-mode'])
    on(id, 'change', () => {
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
        const result = await client.request('connector.connect', {
          connector: 'project-cli',
        })
        if (current(revision)) {
          if (result.connections?.some((entry) => entry.outcome === 'connected'))
            refreshQueued = true
          else
            say(result.connections?.[0]?.explanation ?? 'Connection was not completed.')
        }
      }),
  )
  on(
    'task-reconcile',
    'click',
    () =>
      void guarded(async (revision) => {
        const result = await client.request('actions.invoke', {
          action: 'operation-state',
          input: { mode: 'observe', operationId: pending },
        })
        if (!current(revision)) return
        el('task-result').textContent = JSON.stringify(result, null, 2)
        el('task-operation-details').open = true
        say(
          result.message ??
            'Current facts observed. Original completion remains unknown.',
        )
      }),
  )
  return {
    select(input) {
      invalidate()
      el('task-result').textContent = ''
      el('task-operation-details').open = false
      selection = input
      library = source = installed = undefined
      pending = uncertain.get(taskKey())
      el('selected-task').hidden = !skillId()
      if (skillId()) void refresh()
    },
    contextChanged() {
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
