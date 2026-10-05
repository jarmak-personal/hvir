/* global window, document */
import { guestClient, runCli } from './bridge.mjs'
import {
  requireVersion,
  libraryStatus,
  libraryPage,
  searchPage,
  searchArgs,
  projectInventory,
  projectExposures,
  detailInputFor,
  localWorkspace,
} from './catalog.mjs'
import { sourcePages, loadInstructionImages } from './reader.mjs'
const bridge = window.hvirExtension,
  client = guestClient(bridge)
const releasePresentation = window.hvirUI.bindPresentation(bridge)
const view = document.body.dataset.view
const element = (id) => document.getElementById(id)
let context = { visible: false },
  generation = 0,
  timer,
  busy = false,
  pendingRefresh = false
let lastPage,
  library,
  query = '',
  cursor,
  previous = [],
  searchOptions = {},
  selectedRow,
  pageRequest
const state = element('state'),
  list = element('skills'),
  body = element('instructions')
const verifiedVersions = new Set()
const on = (id, event, callback) => {
  const target = element(id)
  target?.addEventListener(event, callback)
  client.signal.addEventListener(
    'abort',
    () => target?.removeEventListener(event, callback),
    { once: true },
  )
}
function say(message, kind = 'ready') {
  if (state) {
    state.textContent = message
    state.dataset.state = kind
  }
}
async function cli(args, project) {
  const key = project?.workspace?.id ?? 'library'
  if (!verifiedVersions.has(key)) {
    requireVersion(await runCli(client, ['--version'], project))
    verifiedVersions.add(key)
  }
  return JSON.parse(await runCli(client, args, project))
}
function available() {
  return client.alive && context.visible
}
function refreshManagementAvailability() {
  if (element('manage')) element('manage').disabled = !available()
}
function scope() {
  return view === 'project' ? context : undefined
}
function sourceInput(row) {
  return detailInputFor(row)
}
async function choose(row) {
  if (!available()) return
  if (
    row.source === 'project' &&
    (row.host !== 'local' ||
      row.workspaceId !== context.workspace?.id ||
      !localWorkspace(context.workspace))
  )
    throw new Error(
      'Selected installed presence is unknown for this workspace; no host was substituted',
    )
  await client.request('viewer.open-own', {
    contributionId: 'detail',
    ...(row.source === 'library' ? { context: 'application' } : {}),
    input: sourceInput(row),
  })
}
const navigation = list
  ? window.hvirUI.bindList(list, (row) => {
      selectedRow = lastPage?.rows.find((item) => item.id === row.dataset.id)
    })
  : undefined
if (list) {
  list.addEventListener(
    'click',
    (event) => {
      const row = event.target.closest('[role="option"]')
      const item = lastPage?.rows.find((item) => item.id === row?.dataset.id)
      if (item) void choose(item).catch((error) => say(error.message, 'error'))
    },
    { signal: client.signal },
  )
  list.addEventListener(
    'keydown',
    (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && selectedRow) {
        event.preventDefault()
        void choose(selectedRow).catch((error) => say(error.message, 'error'))
      }
    },
    { signal: client.signal },
  )
}
function rows(page) {
  lastPage = page
  const active = list?.querySelector('[aria-selected="true"]')?.dataset.id
  list?.replaceChildren(
    ...page.rows.map((item) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'hvir-button hvir-row hvir-focus'
      row.dataset.variant = 'selectable'
      row.dataset.id = item.id
      row.dataset.sourcePath = item.path
      row.dataset.source = item.source
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(item.id === active))
      const name = document.createElement('strong'),
        description = document.createElement('span')
      name.textContent = item.name
      description.textContent = item.description || item.kind
      row.append(name, description)
      return row
    }),
  )
  navigation?.refresh()
  pagingControls()
  if (!page.rows.length)
    say(
      query
        ? `No matches for “${query}”. Change your search.`
        : view === 'project'
          ? 'No local project skills observed. Discovery coverage is not asserted; your library is independent.'
          : 'Your personal library is empty.',
      'empty',
    )
  else {
    const observation = query
      ? `${page.rows.length} matches · ${page.presence ?? 'unknown'} installed presence · Page ${previous.length + 1}`
      : `${page.rows.length}${library?.count !== null && library?.count !== undefined && view === 'library' ? ` of ${library.count}` : ''} skills${view === 'project' ? ' · Local observations; discovery coverage is not asserted' : ''} · Page ${previous.length + 1} · observed ${new Date().toLocaleTimeString()}`
    if (element('observation-details'))
      element('observation-details').textContent = observation
    say(
      query
        ? `${page.rows.length} matches · Page ${previous.length + 1}`
        : `${page.rows.length}${library?.count !== null && library?.count !== undefined && view === 'library' ? ` of ${library.count}` : ''} skills · Page ${previous.length + 1}`,
    )
  }
}
function pagingControls() {
  const changingSearch =
    pageRequest &&
    (pageRequest.query !== query ||
      JSON.stringify(pageRequest.options) !== JSON.stringify(searchOptions))
  if (element('next')) element('next').disabled = !!changingSearch || !lastPage?.next
  if (element('previous'))
    element('previous').disabled = !!changingSearch || previous.length === 0
}
function requestRefresh(
  target = pageRequest ?? {
    query,
    options: searchOptions,
    cursor,
    previous: [...previous],
  },
) {
  pageRequest = { query, options: searchOptions, ...target }
  pagingControls()
  generation++
  pendingRefresh = true
  void refresh()
}
async function refresh() {
  if (!available() || busy || view === 'detail') return
  pendingRefresh = false
  busy = true
  const revision = generation,
    target = pageRequest ?? {
      query,
      options: searchOptions,
      cursor,
      previous: [...previous],
    }
  say(
    lastPage ? 'Refreshing… last-known rows retained.' : 'Loading Skillager…',
    lastPage ? 'stale' : 'loading',
  )
  try {
    let page
    if (target.query) {
      const workspace = view === 'project' ? localWorkspace(context.workspace) : undefined
      const root = workspace?.root.path
      page = searchPage(
        await cli(
          searchArgs(target.query, {
            ...target.options,
            cursor: target.cursor ?? '',
            ...(root ? { installedProject: root } : {}),
          }),
        ),
        workspace,
      )
    } else if (view === 'project') {
      if (!localWorkspace(context.workspace))
        throw new Error(
          'Project presence is unknown without an available exact local root. Open Your library for independent local browsing; no remote CLI is run.',
        )
      const inventory = projectInventory(
        await cli(
          [
            'review',
            '--source',
            'project',
            '--include-blocked',
            '--include-lint-blocked',
            '--json',
          ],
          scope(),
        ),
        context.workspace,
      )
      const exposures = projectExposures(
        await cli(
          ['expose', '--list', '--all-agents', '--scope', 'project', '--json'],
          scope(),
        ),
        context.workspace,
      )
      const paths = new Set(exposures.map((item) => item.path))
      const observed = [
        ...inventory.rows.filter((item) => !paths.has(item.path)),
        ...exposures,
      ]
      const offset = Number(target.cursor ?? 0)
      page = {
        rows: observed.slice(offset, offset + 100),
        next: offset + 100 < observed.length ? String(offset + 100) : null,
      }
    } else {
      library = libraryStatus(await cli(['library', 'status', '--json']))
      page = libraryPage(
        await cli([
          'list',
          '--scope',
          'library',
          '--json',
          '--limit',
          '100',
          ...(target.cursor ? ['--cursor', target.cursor] : []),
        ]),
      )
    }
    if (available() && generation === revision) {
      query = target.query
      searchOptions = target.options
      cursor = target.cursor
      previous = target.previous
      pageRequest = undefined
      rows(page)
    }
  } catch (error) {
    if (available() && generation === revision)
      say(
        `${error.message}${lastPage ? ' · Last-known rows retained; freshness unavailable.' : ''}`,
        lastPage ? 'stale' : 'error',
      )
  } finally {
    busy = false
    pagingControls()
    if (pendingRefresh && available()) void refresh()
    else schedule()
  }
}
function schedule() {
  window.clearTimeout(timer)
  if (available() && view !== 'detail')
    timer = window.setTimeout(() => requestRefresh(), 30_000 - (Date.now() % 30_000))
}
let detailInput,
  sourceReceipt,
  instructionText = '',
  renderedHtml,
  reading = false,
  pendingSelection = false,
  selectedScroll = 0
const positions = new Map()
function rememberPosition() {
  if (detailInput) {
    positions.set(
      `${detailInput.row.host}:${detailInput.row.workspaceId ?? ''}:${detailInput.row.source}:${detailInput.row.path}`,
      {
        scroll: body.scrollTop,
        mode: body.dataset.mode,
      },
    )
    if (positions.size > 16) positions.delete(positions.keys().next().value)
  }
}
async function showInstructions(text, revision = generation) {
  if (body.dataset.mode === 'source') {
    body.textContent = text
    return
  }
  let renderReceipt
  try {
    let html = renderedHtml
    if (html === undefined) {
      const result = await client.request('source.render', { receipt: sourceReceipt })
      renderReceipt = result.receipt
      html = result.sourceFallback ? null : await sourcePages(client, renderReceipt)
    }
    if (!available() || revision !== generation || body.dataset.mode === 'source') return
    renderedHtml = html
    if (html === null) {
      body.textContent = text
      body.dataset.mode = 'source'
      say(
        'Complete current instructions in Source mode · rendered output exceeds the display bound',
      )
    } else body.innerHTML = html
  } catch (error) {
    if (available() && revision === generation) {
      body.textContent = text
      body.dataset.mode = 'source'
      say(
        `Complete current instructions in Source mode · Rendering unavailable: ${error.message}`,
        'stale',
      )
    }
  } finally {
    if (renderReceipt)
      await client
        .request('source.read', { receipt: renderReceipt, release: true })
        .catch(() => {})
  }
}

async function readSelected() {
  if (!available() || !detailInput?.row || reading) return
  const selecting = pendingSelection
  pendingSelection = false
  reading = true
  const revision = generation,
    row = detailInput.row
  const scroll = selecting ? selectedScroll : body.scrollTop,
    mode = body.dataset.mode
  say('Reading selected current file…', 'loading')
  try {
    if (sourceReceipt)
      await client
        .request('source.read', { receipt: sourceReceipt, release: true })
        .catch(() => {})
    if (
      row.host !== 'local' ||
      (row.source === 'project' && row.workspaceId !== context.workspace?.id)
    )
      throw new Error('Selected source does not match its observing host/workspace')
    const selected = await client.request('source.select', {
      source: row.source,
      path: { hostId: row.host, path: row.path },
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    })
    sourceReceipt = selected.receipt
    const text = await sourcePages(client, selected.receipt)
    if (!available() || revision !== generation) return
    instructionText = text
    renderedHtml = undefined
    body.dataset.mode = mode
    await showInstructions(text, revision)
    if (!available() || revision !== generation) return
    body.scrollTop = scroll
    element('detail-title').textContent = row.name
    element('source-label').textContent =
      `${row.kind} · ${selected.path.hostId}: ${selected.path.path}`
    element('details').dataset.sha256 = selected.sha256
    element('details').textContent =
      `Observation: ${row.status} · Current file read ${new Date(selected.readAt).toLocaleTimeString()} · File SHA-256 ${selected.sha256}. Current-file bytes are not an accepted tree snapshot.${row.matched && row.matched !== row.skillId ? ` Ranking matched ${row.matched}.` : ''}`
    element('canonical').hidden = !row.canonical
    if (body.dataset.mode !== 'source' || mode === 'source')
      say('Current file · reading does not approve or run this skill')
    if (body.dataset.mode !== 'source')
      await loadInstructionImages(
        client,
        body,
        selected.receipt,
        () => available() && revision === generation && body.dataset.mode !== 'source',
      )
  } catch (error) {
    if (available() && revision === generation)
      say(
        `${error.message} · The selected source remains selected; no other occurrence was substituted.`,
        'error',
      )
  } finally {
    reading = false
    if (pendingSelection && available()) void readSelected()
  }
}
on('read-current', 'click', () => {
  selectedScroll = body.scrollTop
  generation++
  pendingSelection = true
  void readSelected()
})
on('reveal-original', 'click', async () => {
  const row = detailInput?.row
  if (
    !available() ||
    row?.source !== 'project' ||
    row.kind !== 'Project original' ||
    row.workspaceId !== context.workspace?.id ||
    row.host !== context.workspace?.host
  )
    return
  try {
    await client.request('source.reveal', {
      source: 'project',
      workspaceId: row.workspaceId,
      path: { hostId: row.host, path: row.path.slice(0, row.path.lastIndexOf('/')) },
    })
    say(
      'Original folder revealed in Files. Its separate file actions own deletion; no original was removed.',
    )
  } catch (error) {
    say(error.message, 'error')
  }
})
on('source-mode', 'click', () => {
  if (instructionText) {
    body.textContent = instructionText
    body.dataset.mode = 'source'
  }
})
on('rendered-mode', 'click', () => {
  if (instructionText) {
    body.dataset.mode = 'rendered'
    const revision = generation,
      receipt = sourceReceipt
    void showInstructions(instructionText, revision).then(
      () =>
        available() &&
        revision === generation &&
        receipt &&
        loadInstructionImages(
          client,
          body,
          receipt,
          () => available() && revision === generation && body.dataset.mode !== 'source',
        ),
    )
  }
})
on('canonical', 'click', async () => {
  const canonical = detailInput?.row.canonical
  if (!canonical || !available()) return
  try {
    const value = await cli(['library', 'status', canonical.skill_id, '--json']),
      current = libraryStatus(value)
    if (
      !current.initialized ||
      current.id !== canonical.library_id ||
      !canonical.skill_id.startsWith('lib/') ||
      value.skill?.id !== canonical.skill_id ||
      value.skill?.status === 'missing'
    )
      throw new Error(
        'Canonical relationship no longer matches the connected current library',
      )
    await choose({
      id: canonical.skill_id,
      name: value.skill.name ?? canonical.skill_id,
      description: value.skill.summary ?? '',
      path: value.skill.entrypoint,
      source: 'library',
      host: 'local',
      kind: 'Your library',
      status: value.skill.acceptance ?? 'observed',
    })
  } catch (error) {
    say(error.message, 'error')
  }
})
on(
  'open-library',
  'click',
  () =>
    void client
      .request('viewer.open-own', { contributionId: 'library', context: 'application' })
      .catch((error) => say(error.message, 'error')),
)
on(
  'manage',
  'click',
  () =>
    void client
      .request('viewer.open-own', {
        contributionId: 'management',
        ...(view === 'detail' && detailInput?.row?.source === 'library'
          ? { input: { row: { id: detailInput.row.id, source: 'library' } } }
          : {}),
      })
      .catch((error) => say(error.message, 'error')),
)
on('search-form', 'submit', (event) => {
  event.preventDefault()
  const options = {
    includeInstalled: element('include-installed').checked,
    separateCopies: element('separate-copies').checked,
    preferredAgent: element('preferred-agent').value || undefined,
  }
  requestRefresh({
    query: element('query').value.trim(),
    options,
    cursor: undefined,
    previous: [],
  })
})
on('browse', 'click', () => {
  element('query').value = ''
  requestRefresh({ query: '', options: {}, cursor: undefined, previous: [] })
})
on('refresh', 'click', () => {
  requestRefresh()
})
on('next', 'click', () => {
  if (!lastPage?.next || busy || element('next').disabled) return
  requestRefresh({ cursor: lastPage.next, previous: [...previous, cursor] })
})
on('previous', 'click', () => {
  if (!previous.length || busy || element('previous').disabled) return
  requestRefresh({ cursor: previous.at(-1), previous: previous.slice(0, -1) })
})
client.listen((message) => {
  if (message.kind === 'context') {
    const renewed = message.context.visible && !context.visible
    const changed =
      JSON.stringify(message.context.workspace) !== JSON.stringify(context.workspace)
    context = message.context
    refreshManagementAvailability()
    if (!context.visible) {
      generation++
      window.clearTimeout(timer)
      if (reading)
        say(
          'Reading interrupted while hidden. Select Read current to finish; partial bytes are not shown.',
          'stale',
        )
    }
    if (view === 'detail') {
      if (context.input && context.input.selection !== detailInput?.selection) {
        rememberPosition()
        generation++
        detailInput = context.input
        element('reveal-original').hidden =
          detailInput.row.source !== 'project' ||
          detailInput.row.kind !== 'Project original'
        pendingSelection = true
        instructionText = ''
        renderedHtml = undefined
        body.replaceChildren()
        const position = positions.get(
          `${detailInput.row.host}:${detailInput.row.workspaceId ?? ''}:${detailInput.row.source}:${detailInput.row.path}`,
        )
        body.dataset.mode = position?.mode ?? 'rendered'
        selectedScroll = position?.scroll ?? 0
      }
      if (pendingSelection && available()) void readSelected()
    } else {
      const installed = element('include-installed'),
        local = view === 'project' && !!localWorkspace(context.workspace)
      if (installed) {
        installed.disabled = !local
        installed.title = local
          ? 'Filter known installed identities before CLI limits'
          : 'Installed presence is unknown; search includes all personal-library candidates'
        if (element('installed-label'))
          element('installed-label').textContent = 'Include installed'
        if (element('installed-note'))
          element('installed-note').textContent = local
            ? 'Installed copies are observed for this project.'
            : 'Installed copies are unknown here. Search covers your personal library.'
        if (changed || !local) installed.checked = local
      }
      if (renewed || changed)
        requestRefresh(changed ? { cursor: undefined, previous: [] } : undefined)
    }
  }
})
window.addEventListener('pagehide', dispose, { once: true })
function dispose() {
  generation++
  window.clearTimeout(timer)
  navigation?.dispose()
  releasePresentation()
  client.dispose()
}
client.signal.addEventListener(
  'abort',
  () => {
    window.clearTimeout(timer)
    navigation?.dispose()
    releasePresentation()
    refreshManagementAvailability()
  },
  { once: true },
)
client.hello()
