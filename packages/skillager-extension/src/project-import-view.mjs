import { managementCli } from './management-cli.mjs'
import { isStaleCatalogCursor } from './catalog-cli.mjs'
import { localWorkspace } from './catalog.mjs'
import {
  observeProjectImport,
  prepareProjectImport,
  projectImportSelection,
  projectImportUpdate,
} from './project-import-contract.mjs'
import { bindReviewFiles } from './review-file-view.mjs'
import { readOperationReport } from './operation-report.mjs'
import { mountProjectImport } from './project-import-template.mjs'

/** Whole-project eligibility and one human batch review, independent of browser paging. */
export function bindProjectImport(document, client, ports) {
  const el = (name) => document.getElementById(`project-import-${name}`),
    entry = document.getElementById('project-save-entry'),
    openButton = document.getElementById('project-save-open'),
    section = mountProjectImport(document, document.getElementById('skill-task-sheet')),
    context = ports.context,
    candidates = new Map(),
    manifests = new Map(),
    selected = new Set()
  let inventory,
    inventoryDirty = true,
    inventoryBusy = false,
    inventoryObservation,
    inventoryRevision = 0,
    inventoryError = '',
    cursor,
    loaded = 0,
    active = false,
    generation = 0,
    visibleRevision = 0,
    preparation = 0,
    preparing = false,
    prepareWanted = false,
    loading = false,
    submitted = false,
    completed = false,
    initialized = false,
    prepared,
    pending,
    observation,
    inspection,
    pagingNotice = '',
    message = '',
    disposed = false
  const workspaceKey = () => JSON.stringify(context().workspace),
    current = (revision = generation) =>
      !disposed && client.alive && generation === revision,
    visible = () =>
      current() &&
      context().visible &&
      ports.project() &&
      !!localWorkspace(context().workspace),
    available = () => visible() && active,
    retained = () => {
      const revision = generation,
        workspace = workspaceKey()
      return () => current(revision) && workspaceKey() === workspace
    }
  const scopedIo = (valid) =>
    managementCli(
      {
        get alive() {
          return valid()
        },
        get visible() {
          return context().visible
        },
        delay: (ms) => client.delay(ms),
        request(capability, input) {
          if (!(capability === 'connector.output' && input.release) && !valid())
            throw new Error('This project review is no longer current.')
          return client.request(capability, input)
        },
      },
      context(),
    )
  const files = bindReviewFiles(document, client, {
    prefix: 'project-import',
    available: () => available() && !!inspection,
    say: (text) => {
      el('file-state').textContent = text
    },
    tree: () => ({
      source: 'project',
      workspaceId: context().workspace.id,
      root: { hostId: 'local', path: inspection.review_manifest.source_root },
      files: inspection.review_manifest.files,
    }),
    readAccess: () => client.request('source.request', { source: 'project' }),
  })
  function closeFiles() {
    inspection = undefined
    files.reset()
    el('inspection').hidden = true
    el('file-state').textContent = ''
  }
  function say(text) {
    message = text
    el('state').textContent = text
  }
  function entryControls() {
    const count = inventory?.summary.eligible ?? 0,
      partial = inventory?.observation.status === 'partial'
    entry.hidden = !visible() || (!count && !inventoryError && !partial)
    document.getElementById('project-save-count').textContent = inventoryError
      ? inventoryError
      : `${count} ${count === 1 ? 'skill' : 'skills'} ready to save${partial ? ' · discovery incomplete' : ''}`
    openButton.hidden = !count || !!inventoryError
    openButton.disabled = submitted || inventoryDirty || inventoryBusy
    openButton.textContent =
      inventory?.default_selection && !partial ? 'Save all…' : 'Save skills…'
  }
  function controls() {
    ports.activity?.(submitted)
    if (disposed) return
    section.setAttribute('aria-busy', String(submitted || preparing || loading))
    const count = selected.size,
      total = inventory?.summary.eligible ?? count,
      limit = inventory?.limits.selection_items,
      unresolved = [...selected].some(
        (id) => candidates.get(id)?.eligibility === 'unobserved',
      )
    el('save').textContent = submitted
      ? 'Saving…'
      : `Save ${count} ${count === 1 ? 'skill' : 'skills'}`
    el('save').disabled =
      !available() || submitted || loading || preparing || !prepared || !!pending
    el('save').hidden = completed || !!pending
    el('selection').textContent =
      unresolved || count > total
        ? `${count} selected`
        : limit && total > limit
          ? `${count} of ${total} selected · ${total - count} remaining. Up to ${limit} per save.`
          : count !== total
            ? `${count} of ${total} selected`
            : ''
    for (const checkbox of el('choices').querySelectorAll('input'))
      checkbox.disabled = submitted || completed || !!pending || !available()
    for (const button of el('choices').querySelectorAll('button'))
      button.disabled = !available() || !manifests.has(button.dataset.occurrence)
    el('more').hidden = !cursor || completed || !!pending
    el('more').disabled = loading || submitted || !available()
    el('more').textContent = loading ? 'Loading skills…' : 'Load more skills'
    el('refresh').hidden =
      completed || !!pending || preparing || loading || !!prepared || !active
    el('refresh').disabled = submitted || !available()
    el('reconcile').hidden = !pending
    el('reconcile').disabled = submitted || loading || !available()
    el('reconcile').textContent = observation ? 'Finish review' : 'Check saved skills'
    el('state').textContent = message
    entryControls()
  }
  function addCandidates(page) {
    let changed = false
    for (const item of page.items) {
      candidates.set(item.occurrence_id, item)
      if (item.eligibility !== 'eligible' && selected.delete(item.occurrence_id))
        changed = true
    }
    cursor = page.next_cursor
    loaded += page.items.length
    if (changed) requestPreparation()
  }
  function renderChoices() {
    const focused = document.activeElement?.dataset.occurrence
    el('choices').replaceChildren()
    for (const [id, item] of candidates) {
      if (item.eligibility !== 'eligible' && !selected.has(id)) continue
      const row = document.createElement('div'),
        label = document.createElement('label'),
        checkbox = document.createElement('input'),
        name = document.createElement('span'),
        inspect = document.createElement('button'),
        manifest = manifests.get(id)?.review_manifest
      row.className = 'project-import-choice'
      label.className = 'hvir-field'
      checkbox.type = 'checkbox'
      checkbox.className = 'hvir-input'
      checkbox.dataset.occurrence = id
      checkbox.checked = selected.has(id)
      name.textContent = item.name
      label.title = `local: ${item.skill_file}`
      checkbox.addEventListener('change', () => {
        if (!available() || submitted || completed || pending) return
        if (checkbox.checked) {
          if (selected.size >= inventory.limits.selection_items) {
            checkbox.checked = false
            say(
              `Choose up to ${inventory.limits.selection_items} skills. Uncheck one to choose another.`,
            )
            return
          }
          selected.add(id)
        } else selected.delete(id)
        say('')
        requestPreparation()
      })
      inspect.className = 'hvir-button project-import-inspect'
      inspect.dataset.occurrence = id
      inspect.textContent = manifest
        ? `${manifest.file_count} ${manifest.file_count === 1 ? 'file' : 'files'}`
        : 'Files'
      inspect.setAttribute('aria-label', `Inspect ${item.name} files`)
      inspect.setAttribute('aria-expanded', String(inspection?.occurrence_id === id))
      inspect.addEventListener('click', () => {
        if (!available() || !manifests.has(id)) return
        if (inspection?.occurrence_id === id) closeFiles()
        else {
          inspection = manifests.get(id)
          el('inspect-name').textContent = item.name
          el('inspection').hidden = false
          files.show(inspection.review_manifest.files)
          el('files').querySelector('button')?.focus({ preventScroll: true })
        }
        for (const button of el('choices').querySelectorAll('button'))
          button.setAttribute(
            'aria-expanded',
            String(button.dataset.occurrence === inspection?.occurrence_id),
          )
      })
      label.append(checkbox, name)
      row.append(label, inspect)
      el('choices').append(row)
    }
    if (focused)
      [...el('choices').querySelectorAll('input')]
        .find((node) => node.dataset.occurrence === focused)
        ?.focus({ preventScroll: true })
    const summary = inventory?.summary,
      skipped = summary
        ? [
            [summary.conflict, 'conflict'],
            [summary.blocked, 'unavailable'],
            [summary.already_saved, 'already saved'],
            [summary.duplicate, 'duplicate'],
          ]
            .filter(([count]) => count)
            .map(([count, label]) => `${count} ${label}`)
            .join(' · ')
        : ''
    el('skipped').hidden = !skipped
    el('skipped-summary').textContent = skipped
    el('conflicts').replaceChildren()
    for (const item of candidates.values()) {
      if (!['conflict', 'blocked'].includes(item.eligibility)) continue
      const line = document.createElement('li')
      line.textContent = `${item.name} · ${item.reason_code?.replaceAll('_', ' ') ?? item.eligibility}`
      el('conflicts').append(line)
    }
    controls()
  }
  function observe() {
    if (inventoryObservation) return inventoryObservation
    if (!visible() || !inventoryDirty || submitted) return Promise.resolve()
    inventoryObservation = readInventory()
    return inventoryObservation
  }
  async function readInventory() {
    inventoryBusy = true
    entryControls()
    try {
      // One physical read and at most one fresh read for changes while it was pending.
      for (
        let attempt = 0;
        attempt < 2 && inventoryDirty && visible() && !submitted;
        attempt++
      ) {
        const revision = inventoryRevision,
          visibility = visibleRevision,
          workspace = workspaceKey(),
          valid = () =>
            visible() &&
            workspace === workspaceKey() &&
            visibility === visibleRevision &&
            revision === inventoryRevision
        try {
          const value = await observeProjectImport(scopedIo(valid), context().workspace)
          if (!valid()) continue
          inventory = value
          inventoryDirty = false
          inventoryError = ''
        } catch (error) {
          if (!valid()) continue
          inventoryDirty = false
          inventoryError =
            error.message === projectImportUpdate
              ? 'Update Skillager to save skills together.'
              : 'Save options unavailable. Refresh skills to check again.'
        }
      }
    } finally {
      inventoryBusy = false
      inventoryObservation = undefined
      entryControls()
    }
  }
  function invalidateInventory() {
    inventoryDirty = true
    inventoryRevision++
    entryControls()
  }
  function requireInventory() {
    if (inventoryDirty || !inventory)
      throw new Error(inventoryError || 'Skills changed. Review this project again.')
    if (inventoryError) throw new Error(inventoryError)
  }
  async function loadMore(minimum = 1, restart = true) {
    const validTask = retained(),
      visibility = visibleRevision,
      valid = () => validTask() && available() && visibility === visibleRevision,
      before = [...candidates.values()].filter(
        (item) => item.eligibility === 'eligible',
      ).length
    // Skip managed-only pages without making the human traverse them. One finite read at a time.
    while (cursor && valid()) {
      const previous = cursor
      let page
      try {
        page = await observeProjectImport(scopedIo(valid), context().workspace, {
          cursor,
        })
      } catch (error) {
        if (!valid() || !restart || !isStaleCatalogCursor(error)) throw error
        // Retire the expired traversal's review and restart this read once, never effects.
        preparation++
        prepared = undefined
        prepareWanted = false
        selected.clear()
        candidates.clear()
        manifests.clear()
        closeFiles()
        cursor = undefined
        loaded = 0
        renderChoices()
        invalidateInventory()
        await observe()
        if (!valid()) return
        requireInventory()
        addCandidates(inventory)
        await proposeSelection(false)
        if (!valid()) return
        pagingNotice = 'Skills changed. Review this selection again.'
        renderChoices()
        requestPreparation()
        return
      }
      if (!valid()) return
      if (
        page.library.root !== inventory.library.root ||
        page.library.library_id !== inventory.library.library_id
      )
        inventoryChanged('Your library changed. Review this project again.')
      addCandidates(page)
      if (cursor === previous || loaded > inventory.limits.inventory_items)
        inventoryChanged('Project paging changed. Review this project again.')
      const count = [...candidates.values()].filter(
        (item) => item.eligibility === 'eligible',
      ).length
      if (count - before >= minimum) return
    }
  }
  function inventoryChanged(message) {
    preparation++
    prepared = undefined
    prepareWanted = false
    manifests.clear()
    cursor = undefined
    inventoryDirty = true
    inventoryRevision++
    closeFiles()
    renderChoices()
    throw new Error(message)
  }
  async function proposeSelection(restart = true) {
    if (inventory.default_selection) {
      for (const id of inventory.default_selection) selected.add(id)
      return
    }
    const validTask = retained(),
      count = () =>
        [...candidates.values()].filter((item) => item.eligibility === 'eligible')
    if (count().length < inventory.limits.selection_items)
      await loadMore(inventory.limits.selection_items - count().length, restart)
    if (!validTask() || !available()) return
    for (const item of count().slice(0, inventory.limits.selection_items))
      selected.add(item.occurrence_id)
  }
  async function recover() {
    const validTask = retained(),
      visibility = visibleRevision,
      valid = () => validTask() && available() && visibility === visibleRevision,
      value = await client.request('actions.invoke', {
        action: 'operation-state',
        input: { mode: 'list' },
      })
    for (const id of value.ids ?? []) {
      if (!valid()) return
      const report = await readOperationReport(client, id)
      if (!valid()) return
      if (
        report.operation.action === 'save-project-skills' &&
        JSON.stringify(report.operation.workspace) === workspaceKey()
      ) {
        pending = id
        el('report').textContent = JSON.stringify(report, null, 2)
        el('operation').hidden = false
        say('A previous save needs inspection before continuing.')
        return
      }
    }
  }
  function requestPreparation(defer = true) {
    preparation++
    prepared = undefined
    observation = undefined
    prepareWanted = true
    closeFiles()
    controls()
    if (defer) document.defaultView.queueMicrotask(() => void prepareLatest())
    else void prepareLatest()
  }
  async function prepareLatest() {
    if (
      !prepareWanted ||
      preparing ||
      loading ||
      submitted ||
      pending ||
      completed ||
      !available()
    )
      return
    prepareWanted = false
    if (!selected.size) {
      say('Choose skills to save.')
      controls()
      return
    }
    const validTask = retained(),
      revision = preparation,
      visibility = visibleRevision,
      valid = () =>
        validTask() &&
        available() &&
        visibility === visibleRevision &&
        revision === preparation,
      selection = JSON.stringify([...selected])
    preparing = true
    say('Preparing…')
    controls()
    try {
      const value = await prepareProjectImport(
        scopedIo(valid),
        selection,
        context().workspace,
      )
      if (!valid()) return
      prepared = value
      for (const item of value.items) {
        manifests.set(item.occurrence_id, item)
        candidates.set(item.occurrence_id, {
          ...candidates.get(item.occurrence_id),
          occurrence_id: item.occurrence_id,
          eligibility: 'eligible',
          name: item.source.name,
          skill_file: item.source.file,
        })
      }
      el('destination').textContent = 'Your library · originals unchanged'
      el('location').hidden = false
      el('location-path').textContent = `local: ${value.library.root}`
      el('initialization').textContent =
        value.library.status === 'will-initialize'
          ? `${value.library.library_id ? 'Reconnects' : 'Creates'} your library${value.library.git_mode === 'system' ? ' with Git history' : ' without Git history'}.`
          : ''
      say(
        value.observation.status === 'partial'
          ? 'Some project skills could not be discovered.'
          : pagingNotice,
      )
      renderChoices()
    } catch (error) {
      if (valid()) say(error.message)
    } finally {
      preparing = false
      controls()
      if (prepareWanted && available()) void prepareLatest()
    }
  }
  async function open(retainSelection) {
    if (!visible()) return
    const previous = new Map(
      (retainSelection ?? []).map((id) => [id, candidates.get(id)]),
    )
    generation++
    active = true
    section.hidden = false
    completed = false
    initialized = false
    pagingNotice = ''
    pending = observation = prepared = undefined
    selected.clear()
    candidates.clear()
    manifests.clear()
    loaded = 0
    cursor = undefined
    el('outcomes').hidden = el('operation').hidden = true
    el('outcomes').replaceChildren()
    el('report').textContent = ''
    el('initialization').textContent = ''
    el('destination').textContent = ''
    el('location').hidden = true
    el('location').open = false
    const validTask = retained()
    loading = true
    say('Preparing…')
    controls()
    try {
      await recover()
      if (!validTask() || !available() || pending) return
      if (!inventory || inventoryDirty || inventoryError) {
        if (inventoryError) invalidateInventory()
        await observe()
      }
      if (!validTask() || !available()) return
      requireInventory()
      addCandidates(inventory)
      if (retainSelection) {
        for (const id of retainSelection) {
          const fresh = candidates.get(id),
            prior = previous.get(id)
          if (fresh?.eligibility === 'eligible') selected.add(id)
          else if (!fresh && prior) {
            // Keep a removable choice, not stale eligibility or prepared authority.
            candidates.set(id, { ...prior, eligibility: 'unobserved' })
            selected.add(id)
          }
        }
      } else await proposeSelection()
      if (!validTask() || !available()) return
      renderChoices()
      initialized = true
      requestPreparation()
    } catch (error) {
      if (validTask() && available()) say(error.message)
    } finally {
      loading = false
      controls()
      if (prepareWanted && available()) await prepareLatest()
      if (validTask() && available())
        el('choices').querySelector('input')?.focus({ preventScroll: true })
    }
  }
  function retire() {
    generation++
    preparation++
    active = false
    prepareWanted = false
    prepared = pending = observation = undefined
    selected.clear()
    manifests.clear()
    closeFiles()
    section.hidden = true
    controls()
  }
  const on = (name, callback) =>
    el(name).addEventListener('click', callback, { signal: client.signal })
  openButton.addEventListener('click', () => ports.open(openButton), {
    signal: client.signal,
  })
  on('close-files', () => {
    const id = inspection?.occurrence_id
    closeFiles()
    const button = [...el('choices').querySelectorAll('button')].find(
      (node) => node.dataset.occurrence === id,
    )
    button?.setAttribute('aria-expanded', 'false')
    button?.focus({ preventScroll: true })
  })
  on('more', async () => {
    if (!available() || loading || submitted) return
    loading = true
    const validTask = retained()
    controls()
    try {
      await loadMore()
      if (validTask() && available()) renderChoices()
    } catch (error) {
      if (validTask() && available()) say(error.message)
    } finally {
      loading = false
      controls()
      if (prepareWanted && available()) void prepareLatest()
    }
  })
  on('refresh', () => {
    if (!available() || submitted || loading || preparing || pending) return
    if (!selected.size || inventoryDirty) void open([...selected])
    else requestPreparation()
  })
  on('save', async () => {
    if (!available() || submitted || preparing || loading || pending || !prepared) return
    const chosen = prepared,
      selection = JSON.stringify(projectImportSelection(JSON.stringify([...selected]))),
      validTask = retained(),
      origin = context().workspace
    if (selection !== JSON.stringify(chosen.selection)) return
    submitted = true
    prepared = undefined
    closeFiles()
    say('Saving…')
    controls()
    try {
      const result = await client.request('actions.invoke', {
        action: 'save-project-skills',
        input: { selection, token: chosen.confirmation_token },
      })
      ports.changed?.(result, origin)
      if (!validTask()) return
      completed = result.outcome === 'verified'
      pending = result.operationId
      el('report').textContent = JSON.stringify(result, null, 2)
      el('operation').hidden = !pending && completed
      say(
        completed
          ? `Saved ${result.counts.accepted} ${result.counts.accepted === 1 ? 'skill' : 'skills'}.`
          : (result.message ?? 'Save completion is unknown. Inspect this operation.'),
      )
      el('outcomes').replaceChildren()
      for (const item of result.items ?? []) {
        if (item.status === 'accepted') continue
        const line = document.createElement('li')
        line.textContent = `${chosen.items[item.index].source.name} · ${item.status}`
        el('outcomes').append(line)
      }
      el('outcomes').hidden = !el('outcomes').childElementCount
    } catch (error) {
      ports.changed?.(undefined, origin, error)
      if (validTask()) say(error.message)
    } finally {
      submitted = false
      controls()
      if (inventoryDirty && visible()) void observe()
    }
  })
  on('reconcile', async () => {
    if (!available() || submitted || loading || !pending) return
    const validTask = retained(),
      visibility = visibleRevision
    loading = true
    controls()
    try {
      const result = await client.request('actions.invoke', {
        action: 'operation-state',
        input: {
          mode: observation ? 'acknowledge' : 'observe',
          operationId: pending,
          ...(observation ? { observation } : {}),
        },
      })
      if (!validTask()) return
      observation =
        available() && visibility === visibleRevision && result.outcome === 'observed'
          ? result.observation
          : undefined
      if (result.outcome === 'reconciled') {
        pending = undefined
        completed = true
        ports.changed?.(result, context().workspace)
      }
      el('report').textContent = JSON.stringify(result, null, 2)
      el('operation').open = true
      say(result.message)
    } catch (error) {
      if (validTask()) say(error.message)
    } finally {
      loading = false
      controls()
    }
  })
  return {
    open,
    observe,
    close: retire,
    get submitted() {
      return submitted
    },
    scopeChanged() {
      entryControls()
    },
    invalidate: invalidateInventory,
    contextChanged() {
      retire()
      inventoryRevision++
      inventoryDirty = true
      inventory = undefined
      inventoryError = ''
      entryControls()
    },
    visibilityChanged() {
      visibleRevision++
      preparation++
      observation = undefined
      prepared = undefined
      closeFiles()
      if (active && visible() && !submitted && !completed && !pending) {
        if (!initialized) void open()
        else requestPreparation(false)
      }
      controls()
    },
    dispose() {
      if (disposed) return
      disposed = true
      retire()
      files.dispose()
    },
  }
}
