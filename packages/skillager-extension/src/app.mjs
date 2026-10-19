/* global window, document */
import { guestClient } from './bridge.mjs'
import { catalogCli } from './catalog-cli.mjs'
import {
  libraryStatus,
  libraryPage,
  searchPage,
  searchArgs,
  projectInventory,
  projectInventoryFailure,
  detailInputFor,
  localWorkspace,
} from './catalog.mjs'
import {
  firstUseFailure,
  setupRequest,
  sameCurrentLibrary,
} from './library-first-use.mjs'
import { bindSkillReader } from './detail-view.mjs'
import { bindCommandMenus } from './command-menus.mjs'
const bridge = window.hvirExtension,
  client = guestClient(bridge)
const releasePresentation = window.hvirUI.bindPresentation(bridge)
bindCommandMenus(document, client.signal)
const view = document.body.dataset.view
const element = (id) => document.getElementById(id)
let context = { visible: false },
  generation = 0,
  connectionIntent = 0,
  selectionIntent = 0,
  timer,
  busy = false,
  pendingRefresh = false,
  libraryStatusNeeded = true,
  connectAvailable = false,
  connectionPending = false,
  connectionPhase = '',
  connectionStatus = '',
  connectionDetail = '',
  setupNeeded = false
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
const cli = catalogCli(
  client,
  () => context,
  () => generation,
)
const reader = body ? bindSkillReader(document, client, { choose }) : undefined
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
  if (element('create-library'))
    element('create-library').disabled = !available() || kind !== 'no-personal-library'
  if (element('library-setup'))
    element('library-setup').hidden = kind !== 'no-personal-library'
}

function available() {
  return client.alive && context.visible
}
function refreshManagementAvailability() {
  if (element('manage')) element('manage').disabled = !available()
  refreshConnectionAvailability()
}
function refreshConnectionAvailability() {
  const button = element('connect-program')
  if (!button) return
  button.hidden =
    !connectAvailable ||
    (!setupNeeded && !connectionPending) ||
    (view === 'project' && !localWorkspace(context.workspace))
  button.disabled = !available() || connectionPending
  button.setAttribute('aria-busy', String(available() && connectionPending))
  const status = element('connection-status')
  if (status) {
    status.textContent = !available()
      ? ''
      : connectionPending
        ? connectionPhase === 'observing'
          ? 'Loading skills…'
          : 'Connecting…'
        : connectionStatus
    status.hidden = !status.textContent
    status.title = connectionDetail
    status.setAttribute('aria-description', connectionDetail)
  }
}
function finishConnection(message = '', detail = '') {
  connectionPending = false
  connectionPhase = ''
  connectionStatus = message
  connectionDetail = detail
  refreshConnectionAvailability()
}

function scope() {
  return view === 'project' ? context : undefined
}
async function choose(row, sourceLibrary) {
  if (!available()) return
  const intent = ++selectionIntent,
    revision = generation
  const current = () =>
    available() && intent === selectionIntent && revision === generation
  if (
    row.source === 'project' &&
    (row.host !== 'local' ||
      row.workspaceId !== context.workspace?.id ||
      !localWorkspace(context.workspace))
  )
    throw new Error(
      'Selected installed presence is unknown for this workspace; no host was substituted',
    )
  const selectedLibrary = sourceLibrary ?? library
  if (!current()) return
  if (row.source === 'library') {
    sameCurrentLibrary(
      row.canonical ? { id: row.canonical.library_id } : selectedLibrary,
      selectedLibrary,
    )
    if (
      row.host !== 'local' ||
      !row.path.startsWith(`${selectedLibrary.root.replace(/\/+$/u, '')}/`)
    )
      throw new Error(
        'Selected occurrence no longer belongs to the reported personal library; no source was substituted.',
      )
  }
  const input = detailInputFor(row, selectedLibrary)
  if (view === 'library') reader.select(input)
  else await client.request('viewer.open-own', { contributionId: 'detail', input })
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
  const observed = new Date().toLocaleTimeString()
  if (element('observation-details'))
    element('observation-details').textContent =
      `${page.rows.length} rows · Page ${previous.length + 1} · observed ${observed}${view === 'project' ? ` · ${page.coverage} project observation\n${page.detail}` : query ? ` · ${page.presence ?? 'unknown'} installed presence` : ''}`
  if (page.coverage === 'partial')
    say(
      `${page.rows.length ? `${page.rows.length} skills · ` : ''}Some project skills could not be loaded.`,
      'partial',
    )
  else if (!page.rows.length)
    say(
      query
        ? `No matches for “${query}”. Change your search.`
        : view === 'project'
          ? 'No skills in this project.'
          : 'Your personal library is empty.',
      view === 'project' ? 'empty' : 'empty-library',
    )
  else
    say(
      query
        ? `${page.rows.length} matches · Page ${previous.length + 1}`
        : `${page.rows.length}${library?.count !== null && library?.count !== undefined && view === 'library' ? ` of ${library.count}` : ''} skills · Page ${previous.length + 1}`,
    )
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
  observeLibrary = true,
) {
  if (!connectionPending) {
    connectionStatus = ''
    connectionDetail = ''
    refreshConnectionAvailability()
  }
  pageRequest = { query, options: searchOptions, ...pageRequest, ...target }
  // A newer page intent cannot discard a refresh whose status has not settled.
  libraryStatusNeeded ||= observeLibrary
  pagingControls()
  generation++
  pendingRefresh = true
  void refresh()
}
async function refresh() {
  if (!available() || busy || view === 'detail' || connectionPhase === 'connecting')
    return
  pendingRefresh = false
  busy = true
  const revision = generation,
    connecting = connectionPhase === 'observing' ? connectionIntent : undefined,
    target = pageRequest ?? {
      query,
      options: searchOptions,
      cursor,
      previous: [...previous],
    }
  say(
    lastPage
      ? view === 'project'
        ? 'Refreshing…'
        : 'Refreshing… last-known rows retained.'
      : view === 'project'
        ? 'Loading project skills…'
        : 'Connecting to Skillager…',
    lastPage ? 'stale' : 'connecting',
  )
  const project = scope(),
    workspace = view === 'project' ? localWorkspace(project?.workspace) : undefined,
    failureDestination = view
  let observedSuccessfully = false
  try {
    let page
    if (view === 'library') {
      if (libraryStatusNeeded || !library) {
        const observed = libraryStatus(await cli(['library', 'status', '--json']))
        if (!available() || generation !== revision) return
        if (library && (library.id !== observed.id || library.root !== observed.root)) {
          selectedRow = undefined
          lastPage = undefined
          list?.replaceChildren()
          cursor = target.cursor = undefined
          previous = target.previous = []
          pagingControls()
          if (element('observation-details'))
            element('observation-details').textContent = ''
          say('Loading your personal library…', 'connecting')
        }
        library = observed
        libraryStatusNeeded = false
      }
      if (element('program-setup')) element('program-setup').hidden = true
      setupNeeded = false
      refreshConnectionAvailability()
      if (!library.initialized) {
        observedSuccessfully = true
        lastPage = undefined
        list?.replaceChildren()
        pageRequest = undefined
        say(
          'No personal library yet. Create one with Skillager’s defaults when you are ready.',
          'no-personal-library',
        )
        return
      }
    }
    if (view === 'project') {
      if (!workspace)
        throw new Error(
          'Project presence is unknown without an available exact local root. Open Your library for independent local browsing; no remote CLI is run.',
        )
      page = projectInventory(
        await cli(
          [
            'list',
            '--scope',
            'project',
            '--json',
            '--limit',
            '100',
            ...(target.query ? ['--query', target.query] : []),
            ...(target.cursor ? ['--cursor', target.cursor] : []),
          ],
          project,
        ),
        workspace,
      )
    } else if (target.query) {
      page = searchPage(
        await cli(
          searchArgs(target.query, { ...target.options, cursor: target.cursor ?? '' }),
        ),
      )
    } else {
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
      setupNeeded = false
      if (element('program-setup')) element('program-setup').hidden = true
      refreshConnectionAvailability()
      rows(page)
      observedSuccessfully = true
    }
  } catch (error) {
    if (available() && generation === revision) {
      const failure = firstUseFailure(
        view === 'project' ? projectInventoryFailure(error) : error,
        !!lastPage,
        failureDestination,
        connectAvailable && (view !== 'project' || !!localWorkspace(context.workspace)),
      )
      if (element('program-setup')) element('program-setup').hidden = !failure.setup
      setupNeeded = failure.setup
      refreshConnectionAvailability()
      if (element('observation-details'))
        element('observation-details').textContent = failure.detail
      say(failure.message, failure.state)
    }
  } finally {
    if (available() && generation === revision && connecting === connectionIntent)
      finishConnection(observedSuccessfully ? 'Connected' : 'Could not load skills')
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
on(
  'open-library',
  'click',
  () =>
    void client
      .request('viewer.open-own', { contributionId: 'library' })
      .catch((error) => say(error.message, 'error')),
)
on(
  'manage',
  'click',
  () =>
    void client
      .request('viewer.open-own', {
        contributionId: 'management',
      })
      .catch((error) => say(error.message, 'error')),
)
if (element('setup-request')) element('setup-request').value = setupRequest
on('create-library', 'click', async () => {
  if (!available() || busy || library?.initialized) return
  busy = true
  const revision = ++generation
  say('Creating your personal library with Skillager’s defaults…', 'connecting')
  try {
    const result = await client.request('actions.invoke', {
      action: 'initialize-library',
      input: { location: 'default' },
    })
    if (!available() || generation !== revision) return
    if (result?.outcome !== 'verified' || !result.connect || !result.observed)
      throw new Error(
        result?.message ??
          'Skillager did not verify creation of the default library. No ready state is claimed.',
      )
    // The existing action owns initialization; bind its verified result to fresh public status.
    if (result.observed.root?.hostId !== 'local')
      throw new Error('Skillager did not verify an application-local default library.')
    const observed = libraryStatus(await cli(['library', 'status', '--json']))
    if (!available() || generation !== revision) return
    library = sameCurrentLibrary(
      { id: result.observed.id, root: result.observed.root.path },
      observed,
    )
    pendingRefresh = true
  } catch (error) {
    if (available() && generation === revision) say(error.message, 'failed-observation')
  } finally {
    busy = false
    if (pendingRefresh && available())
      requestRefresh({ query: '', options: {}, cursor: undefined, previous: [] })
  }
})
on('connect-program', 'click', async () => {
  const workspace = view === 'project' ? localWorkspace(context.workspace) : undefined
  if (
    !available() ||
    !connectAvailable ||
    connectionPending ||
    (view === 'project' && !workspace)
  )
    return
  const admitted = ++connectionIntent,
    identity = JSON.stringify(workspace),
    connector = workspace ? 'project-cli' : 'library-cli'
  const current = () =>
    available() &&
    admitted === connectionIntent &&
    (view !== 'project' || identity === JSON.stringify(localWorkspace(context.workspace)))
  connectionPending = true
  connectionPhase = 'connecting'
  connectionStatus = ''
  connectionDetail = ''
  pendingRefresh ||= busy
  generation++
  refreshConnectionAvailability()
  say(
    view === 'project'
      ? 'Connecting Skillager for this project…'
      : 'Connecting to Skillager…',
    'connecting',
  )
  try {
    // Main owns any submitted picker/write even if this result's UI lifetime ends.
    const result = await client.request('connector.connect', { connector })
    if (!current()) return
    const connection = result.connections?.find((entry) => entry.connector === connector)
    if (connection?.outcome === 'connected') {
      connectionPhase = 'observing'
      refreshConnectionAvailability()
      requestRefresh()
    } else {
      setupNeeded = true
      if (element('program-setup')) element('program-setup').hidden = false
      if (element('observation-details'))
        element('observation-details').textContent = connection?.explanation ?? ''
      say(
        view === 'project'
          ? connection?.outcome === 'interrupted-uncertain'
            ? 'Skillager’s connection for this project could not be confirmed. Access may have been saved; normal refresh will check it. Choose Connect Skillager to try again if needed, or set it up with your agent.'
            : connection?.outcome === 'declined'
              ? 'Skillager was not connected for this project. Choose Connect Skillager when ready, or set it up with your agent.'
              : 'Skillager could not connect for this project. Set it up with your agent, then choose Connect Skillager.'
          : (connection?.explanation ??
              'Not connected. Choose Connect Skillager when ready.'),
        connection?.outcome === 'interrupted-uncertain' ? 'error' : 'unapproved',
      )
      connectionStatus =
        connection?.outcome === 'declined' ? 'Not connected' : 'Connection not confirmed'
    }
  } catch (error) {
    if (current()) {
      setupNeeded = true
      if (element('program-setup')) element('program-setup').hidden = false
      say(error.message, 'error')
      connectionStatus = 'Connection failed'
    }
  } finally {
    if (admitted === connectionIntent && connectionPhase !== 'observing') {
      finishConnection(connectionStatus, element('state')?.textContent ?? '')
      if (pendingRefresh && available()) void refresh()
      else schedule()
    }
  }
})
on('search-form', 'submit', (event) => {
  event.preventDefault()
  const options = {
    includeInstalled: element('include-installed').checked,
    separateCopies: element('separate-copies').checked,
    preferredAgent: element('preferred-agent').value || undefined,
  }
  requestRefresh(
    {
      query: element('query').value.trim(),
      options,
      cursor: undefined,
      previous: [],
    },
    false,
  )
})
on('browse', 'click', () => {
  element('query').value = ''
  requestRefresh({ query: '', options: {}, cursor: undefined, previous: [] }, false)
})
on('refresh', 'click', () => {
  // Opaque cursors may expire as skills change; an explicit refresh starts a new page set.
  requestRefresh({ cursor: undefined, previous: [] })
})
on('next', 'click', () => {
  if (!lastPage?.next || element('next').disabled) return
  requestRefresh({ cursor: lastPage.next, previous: [...previous, cursor] }, false)
})
on('previous', 'click', () => {
  if (!previous.length || element('previous').disabled) return
  requestRefresh({ cursor: previous.at(-1), previous: previous.slice(0, -1) }, false)
})
client.listen((message) => {
  if (message.kind === 'hello') {
    connectAvailable = message.capabilities.includes('connector.connect')
    refreshConnectionAvailability()
  }
  if (message.kind === 'context') {
    const renewed = message.context.visible && !context.visible
    const changed =
      JSON.stringify(message.context.workspace) !== JSON.stringify(context.workspace)
    context = message.context
    if (view === 'project' && (changed || !context.visible)) {
      connectionIntent++
      finishConnection()
    }
    refreshManagementAvailability()
    reader?.context(context)
    if (!context.visible) {
      generation++
      window.clearTimeout(timer)
    }
    if (view !== 'detail') {
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
      if (renewed || (changed && view === 'project'))
        requestRefresh(
          changed && view === 'project' ? { cursor: undefined, previous: [] } : undefined,
        )
    }
  }
})
window.addEventListener('pagehide', dispose, { once: true })
function dispose() {
  connectionIntent++
  finishConnection()
  reader?.dispose()
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
    reader?.dispose()
  },
  { once: true },
)
client.hello()
