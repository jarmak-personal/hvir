import { bindSelectedTaskSurface } from './selected-task-surface.mjs'
import { occurrenceFolder } from './catalog.mjs'
import { bindProjectImport } from './project-import-view.mjs'

/** The browser that starts a task owns its review and inventory refresh. */
export function bindBrowserTaskSheet(document, client, ports) {
  const el = (id) => document.getElementById(id),
    sheet = el('skill-task-sheet'),
    slot = document.querySelector('[data-skill-tasks]'),
    home = slot.parentNode,
    context = ports.context,
    surface = ports.reader?.tasks ?? bindSelectedTaskSurface(document, client, ports)
  let selection,
    action,
    trigger,
    generation = 0,
    preparationSerial = 0,
    pending = false,
    preparing = false,
    completed = false,
    suspended = false,
    resumeNeeded = false,
    terminalMessage = '',
    disposed = false
  const current = (revision = generation) =>
    !disposed && client.alive && generation === revision
  const available = (revision = generation) => current(revision) && context().visible
  const message = (text) => {
    el('skill-task-message').textContent = text
  }
  const on = (id, callback) =>
    el(id).addEventListener('click', callback, { signal: client.signal })
  const batch = document.getElementById('project-save-entry')
    ? bindProjectImport(document, client, {
        context,
        project: ports.project,
        open: (source) => void openProjectImport(source),
        changed: ports.changed,
        activity: () => update(),
      })
    : undefined
  const working = () => pending || surface.submitted || !!batch?.submitted
  const visible = (node) => node && !node.closest('[hidden]')
  const decision = () =>
    [
      ...sheet.querySelectorAll(
        '#task-confirm, #import-save, #exposure-confirm, #task-primary, #accept-version',
      ),
    ].find((node) => visible(node) && !node.disabled)
  const update = () => {
    el('skill-task-close').disabled = working()
    sheet.setAttribute('aria-busy', String(working() || preparing))
    const uncertain = ['task-reconcile', 'import-reconcile', 'exposure-reconcile'].some(
      (id) => visible(el(id)),
    )
    el('skill-task-retry').hidden =
      sheet.hidden ||
      action === 'project-import' ||
      working() ||
      preparing ||
      completed ||
      !selection ||
      ['remove-original', 'reveal'].includes(sheet.dataset.task) ||
      !!decision() ||
      uncertain
    ports.activity?.(working())
  }
  // Owner controls settle synchronously; project their final presentation into this sheet.
  surface.onActivity(() =>
    document.defaultView.queueMicrotask(() => {
      update()
      if (resumeNeeded && !working() && available()) resume()
    }),
  )
  surface.onChanged((result, origin, error) => {
    if (selection && JSON.stringify(origin) === JSON.stringify(context().workspace)) {
      completed = result?.outcome === 'verified'
      terminalMessage =
        error?.message ??
        result?.message ??
        result?.reason ??
        (completed
          ? 'Completed.'
          : 'Completion could not be confirmed. Review its state.')
      if (suspended || resumeNeeded) message(terminalMessage)
      document.defaultView.queueMicrotask(update)
    }
  })
  function close(restore = true) {
    if (working()) return false
    if (sheet.hidden) return true
    generation++
    selection = action = undefined
    batch?.close()
    slot.hidden = false
    preparing = false
    suspended = resumeNeeded = false
    terminalMessage = ''
    sheet.hidden = true
    if (slot.parentNode !== home) home.append(slot)
    if (ports.reader && restore) ports.reader.restoreTasks()
    else surface.select(undefined)
    if (restore) {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
      else ports.returnFocus?.()
    }
    trigger = undefined
    update()
    return true
  }
  on('skill-task-close', () => close())
  on('skill-task-retry', () => {
    if (selection && !working() && !preparing) void prepare(selection, action, generation)
  })
  sheet.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || working()) return
      event.preventDefault()
      event.stopPropagation()
      close()
    },
    { signal: client.signal },
  )
  async function open(input, task, source) {
    if (!available() || working()) return
    if (action === 'project-import') close(false)
    if (task === 'router') {
      await ports.choose(input.row, input.library)
      return
    }
    const row = input.row
    if (
      row.source === 'project' &&
      (row.host !== context().workspace?.host ||
        row.workspaceId !== context().workspace?.id)
    )
      throw new Error('Select this skill in its original project.')
    if (task === 'reveal') close(false)
    generation++
    const revision = generation,
      origin = context().workspace
    if (task === 'reveal') {
      pending = true
      source?.setAttribute('aria-busy', 'true')
      update()
      try {
        await client.request('source.reveal', {
          source: 'project',
          workspaceId: row.workspaceId,
          path: occurrenceFolder(row),
        })
      } catch (error) {
        if (available(revision)) {
          sheet.hidden = false
          sheet.dataset.task = 'reveal'
          el('skill-task-title').textContent = row.name
          message(error.message)
        }
      } finally {
        pending = false
        source?.removeAttribute('aria-busy')
        update()
      }
      return
    }
    selection = input
    action = task
    completed = false
    suspended = resumeNeeded = false
    terminalMessage = ''
    trigger = source
    sheet.hidden = false
    sheet.dataset.task = task
    el('skill-task-title').textContent = row.name
    message('')
    const target = sheet.querySelector('[data-skill-task-sheet-target]')
    if (target) target.append(slot)
    if (task === 'remove' && row.kind === 'Project original') {
      sheet.dataset.task = 'remove-original'
      surface.select(undefined)
      if (task === 'remove' && row.host !== 'local') {
        // Execution also rejects unsupported direct callers; menu eligibility is presentation.
        message('Recoverable removal is available on local projects. Use Show in Files.')
        return
      }
      pending = true
      update()
      message('Waiting for Trash decision…')
      try {
        const result = await client.request('source.request-trash', {
          source: 'project',
          workspaceId: row.workspaceId,
          path: occurrenceFolder(row),
        })
        ports.changed(result, origin)
        if (current(revision)) {
          message(
            result.outcome === 'completed'
              ? 'Moved to Trash.'
              : result.outcome === 'cancelled'
                ? 'Cancelled.'
                : (result.reason ?? 'Removal could not be confirmed.'),
          )
        }
      } catch (error) {
        ports.changed(undefined, origin)
        if (current(revision)) message(error.message)
      } finally {
        pending = false
        update()
      }
      return
    }
    await prepare(input, task, revision)
  }
  async function openProjectImport(source) {
    if (!batch || !available() || working() || !ports.project()) return
    close(false)
    generation++
    action = 'project-import'
    trigger = source
    sheet.hidden = false
    sheet.dataset.task = action
    el('skill-task-title').textContent = 'Save to library'
    message('')
    surface.select(undefined)
    slot.hidden = true
    update()
    await batch.open()
  }
  async function prepare(input, task, revision) {
    const preparation = ++preparationSerial,
      currentPreparation = () => available(revision) && preparation === preparationSerial
    preparing = true
    completed = false
    message('Preparing…')
    update()
    try {
      await surface.prepare(input, task)
      if (currentPreparation() && selection === input && action === task) {
        message('')
        decision()?.focus({ preventScroll: true })
      }
    } catch (error) {
      if (currentPreparation()) message(error.message)
    } finally {
      if (currentPreparation()) preparing = false
      update()
    }
  }
  function resume() {
    if (!selection || !available() || working()) return
    resumeNeeded = false
    if (!['remove-original', 'reveal'].includes(sheet.dataset.task)) {
      surface.visibilityChanged({ completed })
      if (terminalMessage) message(terminalMessage)
      else message('')
    }
    update()
  }
  return {
    open,
    close,
    get active() {
      return !!selection || action === 'project-import'
    },
    get busy() {
      return working()
    },
    contextChanged() {
      const ownsSurface = !ports.reader || !!selection || action === 'project-import'
      generation++
      selection = action = undefined
      batch?.contextChanged()
      slot.hidden = false
      preparing = false
      suspended = resumeNeeded = false
      terminalMessage = ''
      sheet.hidden = true
      if (slot.parentNode !== home) home.append(slot)
      if (ownsSurface) surface.select(undefined)
      trigger = undefined
      update()
    },
    visibilityChanged(visible) {
      batch?.visibilityChanged()
      if (action === 'project-import') {
        sheet.hidden = !visible
        update()
        return
      }
      if (!selection) return
      suspended = !visible
      sheet.hidden = !visible
      if (!visible) {
        preparationSerial++
        preparing = false
        surface.visibilityChanged()
      } else {
        resumeNeeded = true
        if (!working()) resume()
      }
      update()
    },
    observeProject() {
      void batch?.observe()
    },
    invalidateProject() {
      batch?.invalidate()
    },
    scopeChanged() {
      batch?.scopeChanged()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      batch?.dispose()
      surface.onActivity(undefined)
      surface.onChanged(undefined)
      if (!ports.reader) surface.dispose()
    },
  }
}
