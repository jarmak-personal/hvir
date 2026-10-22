/* global window, document */
import { guestClient } from './bridge.mjs'
import { catalogCli, isStaleCatalogCursor } from './catalog-cli.mjs'
import {
  libraryStatus,
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
import { libraryGroups, libraryGroupingFailure } from './library-source-catalog.mjs'
import { bindLibrarySources } from './library-source-view.mjs'
import { bindSkillList } from './skill-list-view.mjs'
import { bindBrowserTaskSheet } from './browser-task-sheet.mjs'
import { bindCommandMenus } from './command-menus.mjs'
const bridge = window.hvirExtension,
  client = guestClient(bridge)
const releasePresentation = window.hvirUI.bindPresentation(bridge)
const view = document.body.dataset.view
let browserScope = view === 'project' ? 'project' : 'library'
const scopes = new Map()
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
  searchOptions = browserScope === 'library' ? {} : undefined,
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
const changed = (_result, origin) => {
  // A hidden same-context refresh queues normally. A different workspace refreshes on return.
  if (JSON.stringify(origin) === JSON.stringify(context.workspace)) {
    sheet?.invalidateProject()
    requestRefresh()
  }
}
const reader = body ? bindSkillReader(document, client, { choose, changed }) : undefined
const sheet = list
  ? bindBrowserTaskSheet(document, client, {
      context: () => context,
      project: () => browserScope === 'project',
      reader,
      choose,
      changed,
      activity: refreshConnectionAvailability,
      returnFocus: () => navigation?.focusCurrent(),
    })
  : undefined
bindCommandMenus(document, client.signal)
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
  for (const id of ['scope-project', 'scope-library'])
    if (element(id))
      element(id).disabled = !available() || connectionPending || !!sheet?.busy
  const button = element('connect-program')
  if (!button) return
  button.hidden =
    !connectAvailable ||
    (!setupNeeded && !connectionPending) ||
    (browserScope === 'project' && !localWorkspace(context.workspace))
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
  return browserScope === 'project' ? context : undefined
}
async function choose(row, sourceLibrary) {
  if (!available() || sheet?.busy) return
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
  sheet?.close(false)
  const input = detailInputFor(row, selectedLibrary)
  selectedRow = row
  if (view === 'library') reader.select(input)
  else await client.request('viewer.open-own', { contributionId: 'detail', input })
}
const navigation = list
  ? bindSkillList(document, list, {
      available: () => available() && !sheet?.busy,
      workspace: () => context.workspace,
      emptyFocus: () => element('query')?.focus(),
      selected: (row) => {
        selectedRow = row
      },
      choose: (row) => void choose(row).catch((error) => say(error.message, 'error')),
      task: (row, action, trigger) =>
        void sheet
          .open(detailInputFor(row, library), action, trigger)
          .catch((error) => say(error.message, 'error')),
    })
  : undefined
const sources = list
  ? bindLibrarySources(document, list, navigation, client, {
      context: () => context,
      available: () =>
        available() && browserScope === 'library' && !(pageRequest?.query ?? query),
      selected: () => selectedRow,
    })
  : undefined
function rows(page, observe = true) {
  lastPage = page
  if (page.groups) {
    sources?.render(page, library, observe)
    pagingControls()
    if (element('observation-details')) element('observation-details').textContent = ''
    say(
      page.total
        ? `${page.total} ${page.total === 1 ? 'skill' : 'skills'} · ${page.totalGroups} ${page.totalGroups === 1 ? 'source' : 'sources'}${previous.length || page.next ? ` · Page ${previous.length + 1}` : ''}${page.errors ? ' · Some skills could not be listed' : ''}`
        : page.errors
          ? 'Library skills could not be listed. Try refreshing.'
          : 'Your personal library is empty.',
      page.errors ? 'partial' : page.total ? 'ready' : 'empty-library',
    )
    return
  }
  navigation?.render(page.rows, selectedRow?.id)
  pagingControls()
  if (element('observation-details'))
    element('observation-details').textContent =
      page.coverage === 'partial' ? page.detail : ''
  if (page.coverage === 'partial')
    say(
      `${page.rows.length ? `${page.rows.length} ${page.rows.length === 1 ? 'skill' : 'skills'} · ` : ''}Some project skills could not be loaded.`,
      'partial',
    )
  else if (!page.rows.length)
    say(
      query
        ? `No matches for “${query}”. Change your search.`
        : browserScope === 'project'
          ? 'No skills in this project.'
          : 'Your personal library is empty.',
      browserScope === 'project' ? 'empty' : 'empty-library',
    )
  else {
    const pages = previous.length || page.next ? ` · Page ${previous.length + 1}` : ''
    const noun = query
      ? page.rows.length === 1
        ? 'match'
        : 'matches'
      : page.rows.length === 1
        ? 'skill'
        : 'skills'
    say(`${page.rows.length} ${noun}${pages}`)
  }
}
function pagingControls() {
  if (element('skill-pages'))
    element('skill-pages').hidden = !previous.length && !lastPage?.next
  const changingSearch =
    pageRequest &&
    (pageRequest.query !== query ||
      (browserScope === 'library' &&
        JSON.stringify(pageRequest.options) !== JSON.stringify(searchOptions)))
  if (element('next')) element('next').disabled = !!changingSearch || !lastPage?.next
  if (element('previous'))
    element('previous').disabled = !!changingSearch || previous.length === 0
}
function requestRefresh(
  target = pageRequest ?? {
    query,
    ...(browserScope === 'library' ? { options: searchOptions } : {}),
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
  pageRequest = {
    query,
    ...(browserScope === 'library' ? { options: searchOptions } : {}),
    ...pageRequest,
    ...target,
  }
  if (browserScope !== 'library' || pageRequest.query) sources?.pause()
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
      ...(browserScope === 'library' ? { options: searchOptions } : {}),
      cursor,
      previous: [...previous],
    }
  say(
    lastPage
      ? browserScope === 'project'
        ? 'Refreshing…'
        : 'Refreshing… last-known rows retained.'
      : browserScope === 'project'
        ? 'Loading project skills…'
        : 'Connecting to Skillager…',
    lastPage ? 'stale' : 'connecting',
  )
  const project = scope(),
    workspace =
      browserScope === 'project' ? localWorkspace(project?.workspace) : undefined,
    failureDestination = browserScope
  let observedSuccessfully = false
  try {
    let page,
      projectRead = true
    if (browserScope === 'library') {
      if (libraryStatusNeeded || !library) {
        const observed = libraryStatus(await cli(['library', 'status', '--json']))
        if (!available() || generation !== revision) return
        if (library && (library.id !== observed.id || library.root !== observed.root)) {
          sources?.pause()
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
        sources?.pause()
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
    if (browserScope === 'project') {
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
      page = libraryGroups(
        await cli([
          'list',
          '--scope',
          'library',
          '--json',
          '--limit',
          '100',
          '--group-by',
          'source',
          ...(target.cursor ? ['--cursor', target.cursor] : []),
        ]),
      )
    }
    if (workspace) {
      const scopes = await client.request('source.status', {})
      projectRead = scopes.some((entry) => entry.source === 'project' && entry.granted)
    }
    if (available() && generation === revision) {
      query = target.query
      searchOptions = target.options
      cursor = target.cursor
      previous = target.previous
      pageRequest = undefined
      setupNeeded = !projectRead
      if (element('program-setup')) element('program-setup').hidden = !setupNeeded
      refreshConnectionAvailability()
      rows(page)
      if (browserScope === 'project') sheet?.observeProject()
      observedSuccessfully = true
    }
  } catch (error) {
    if (available() && generation === revision) {
      if (target.cursor && isStaleCatalogCursor(error)) {
        // A changed snapshot invalidates only its traversal, never the query or a mutation.
        requestRefresh({ ...target, cursor: undefined, previous: [] }, false)
        return
      }
      const failure = firstUseFailure(
        browserScope === 'project'
          ? projectInventoryFailure(error)
          : libraryGroupingFailure(error),
        !!lastPage,
        failureDestination,
        connectAvailable &&
          (browserScope !== 'project' || !!localWorkspace(context.workspace)),
      )
      if (element('program-setup')) element('program-setup').hidden = !failure.setup
      setupNeeded = failure.setup
      refreshConnectionAvailability()
      if (element('observation-details'))
        element('observation-details').textContent =
          failure.state === 'missing-program' ? '' : failure.detail
      say(
        failure.state === 'missing-program' && connectAvailable
          ? 'Connect Skillager to browse skills.'
          : failure.message,
        failure.state,
      )
    }
  } finally {
    if (available() && generation === revision && connecting === connectionIntent)
      finishConnection(observedSuccessfully ? '' : 'Could not load skills')
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
function changeScope(next) {
  if (
    view !== 'project' ||
    next === browserScope ||
    connectionPending ||
    sheet?.busy ||
    !available()
  )
    return
  navigation?.close()
  sources?.pause()
  sheet?.close(false)
  scopes.set(browserScope, {
    query,
    cursor,
    previous,
    searchOptions,
    selectedRow,
    lastPage,
    pageRequest,
    draft: element('query').value,
    scroll: list.scrollTop,
  })
  browserScope = next
  sheet?.scopeChanged()
  const saved = scopes.get(next) ?? { query: '', previous: [], searchOptions: {} }
  ;({ query, cursor, previous, searchOptions, selectedRow, lastPage, pageRequest } =
    saved)
  element('query').value = saved.draft ?? query
  element('query').placeholder =
    next === 'project' ? 'Filter project skills' : 'Search library'
  element('query').setAttribute(
    'aria-label',
    next === 'project' ? 'Search project skills' : 'Search library skills',
  )
  for (const name of ['project', 'library'])
    element(`scope-${name}`).setAttribute('aria-pressed', String(name === next))
  connectionIntent++
  finishConnection()
  setupNeeded = false
  list.replaceChildren()
  if (lastPage) rows(lastPage, false)
  list.scrollTop = saved.scroll ?? 0
  if (selectedRow) void choose(selectedRow).catch((error) => say(error.message, 'error'))
  requestRefresh()
}
on('scope-project', 'click', () => changeScope('project'))
on('scope-library', 'click', () => changeScope('library'))
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
  const workspace =
    browserScope === 'project' ? localWorkspace(context.workspace) : undefined
  if (
    !available() ||
    !connectAvailable ||
    connectionPending ||
    (browserScope === 'project' && !workspace)
  )
    return
  const admitted = ++connectionIntent,
    identity = JSON.stringify(workspace),
    connector = workspace ? 'project-cli' : 'library-cli'
  const current = () =>
    available() &&
    admitted === connectionIntent &&
    (browserScope !== 'project' ||
      identity === JSON.stringify(localWorkspace(context.workspace)))
  connectionPending = true
  connectionPhase = 'connecting'
  connectionStatus = ''
  connectionDetail = ''
  pendingRefresh ||= busy
  generation++
  refreshConnectionAvailability()
  say(
    browserScope === 'project'
      ? 'Connecting Skillager for this project…'
      : 'Connecting to Skillager…',
    'connecting',
  )
  try {
    // Main owns any submitted picker/write even if this result's UI lifetime ends.
    const result = await client.request('connector.connect', {
      connector,
      ...(workspace ? { source: 'project' } : {}),
    })
    if (!current()) return
    const connection = result.connections?.find((entry) => entry.connector === connector)
    if (
      connection?.outcome === 'connected' &&
      (!workspace ||
        (result.source?.outcome === 'granted' &&
          result.readiness?.program === true &&
          result.readiness?.source === true))
    ) {
      connectionPhase = 'observing'
      sheet?.invalidateProject()
      refreshConnectionAvailability()
      requestRefresh()
    } else {
      setupNeeded = true
      if (element('program-setup')) element('program-setup').hidden = false
      if (element('observation-details'))
        element('observation-details').textContent = connection?.explanation ?? ''
      say(
        browserScope === 'project'
          ? connection?.outcome === 'connected'
            ? result.readiness?.program === true
              ? 'The program is connected. Project read access was not confirmed. Choose Connect Skillager when ready.'
              : result.readiness?.program === false
                ? 'Program access was saved but is no longer ready. Choose Connect Skillager to check the remaining access.'
                : 'Connection ended before access could be confirmed. Choose Connect Skillager to check again.'
            : connection?.outcome === 'interrupted-uncertain'
              ? 'Skillager’s connection for this project could not be confirmed. Access may have been saved; normal refresh will check it. Choose Connect Skillager to try again if needed, or set it up with your agent.'
              : connection?.outcome === 'declined'
                ? 'Skillager was not connected for this project. Choose Connect Skillager when ready, or set it up with your agent.'
                : 'Skillager could not connect for this project. Set it up with your agent, then choose Connect Skillager.'
          : (connection?.explanation ??
              'Not connected. Choose Connect Skillager when ready.'),
        connection?.outcome === 'interrupted-uncertain' ? 'error' : 'unapproved',
      )
      connectionStatus =
        connection?.outcome === 'declined' || result.source?.outcome === 'declined'
          ? 'Not connected'
          : 'Connection not confirmed'
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
  requestRefresh(
    {
      query: element('query').value.trim(),
      ...(browserScope === 'library'
        ? {
            options: {
              includeInstalled: element('include-installed')?.checked ?? false,
              separateCopies: element('separate-copies')?.checked ?? false,
              preferredAgent: element('preferred-agent')?.value || undefined,
            },
          }
        : {}),
      cursor: undefined,
      previous: [],
    },
    false,
  )
})
on('browse', 'click', () => {
  element('query').value = ''
  requestRefresh(
    {
      query: '',
      ...(browserScope === 'library' ? { options: {} } : {}),
      cursor: undefined,
      previous: [],
    },
    false,
  )
})
on('refresh', 'click', () => {
  sheet?.invalidateProject()
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
    if (changed || !context.visible) {
      navigation?.close()
      sources?.pause()
    }
    if (!changed && renewed && browserScope === 'library' && lastPage?.groups && library)
      sources?.render(lastPage, library, false)
    if (changed) sheet?.contextChanged()
    if (view === 'project' && changed) {
      scopes.clear()
      connectionIntent++
      finishConnection()
    }
    refreshManagementAvailability()
    reader?.context(context, { tasks: !sheet?.active })
    if (!changed && (!context.visible || renewed))
      sheet?.visibilityChanged(context.visible)
    if (!context.visible) {
      generation++
      window.clearTimeout(timer)
    }
    if (view !== 'detail') {
      const installed = element('include-installed'),
        local = browserScope === 'project' && !!localWorkspace(context.workspace)
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
      // Trusted destination changes retire in-flight requests in main, including Library metadata.
      if (renewed || changed)
        requestRefresh(
          changed && browserScope === 'project'
            ? { cursor: undefined, previous: [] }
            : undefined,
        )
    }
  }
})
window.addEventListener('pagehide', dispose, { once: true })
function dispose() {
  connectionIntent++
  finishConnection()
  sheet?.dispose()
  reader?.dispose()
  generation++
  window.clearTimeout(timer)
  sources?.dispose()
  navigation?.dispose()
  releasePresentation()
  client.dispose()
}
client.signal.addEventListener(
  'abort',
  () => {
    window.clearTimeout(timer)
    sources?.dispose()
    navigation?.dispose()
    releasePresentation()
    refreshManagementAvailability()
    sheet?.dispose()
    reader?.dispose()
  },
  { once: true },
)
client.hello()
