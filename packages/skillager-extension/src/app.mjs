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
  selectedRow
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
function scope() {
  return view === 'project' ? context : undefined
}
function sourceInput(row) {
  return detailInputFor(row)
}
async function choose(row) {
  if (!available()) return
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
  if (element('next')) element('next').disabled = !page.next
  if (element('previous')) element('previous').disabled = previous.length === 0
  if (!page.rows.length)
    say(
      query
        ? `No matches for “${query}”. Change your search.`
        : view === 'project'
          ? 'No local project skills observed. Discovery coverage is not asserted; your library is independent.'
          : 'Your personal library is empty.',
      'empty',
    )
  else
    say(
      query
        ? `${page.rows.length} matches · ${page.presence ?? 'unknown'} installed presence · Page ${previous.length + 1}`
        : `${page.rows.length}${library?.count !== null && library?.count !== undefined && view === 'library' ? ` of ${library.count}` : ''} skills${view === 'project' ? ' · Local observations; discovery coverage is not asserted' : ''} · Page ${previous.length + 1} · observed ${new Date().toLocaleTimeString()}`,
    )
}
function requestRefresh() {
  generation++
  pendingRefresh = true
  void refresh()
}
async function refresh() {
  if (!available() || busy || view === 'detail') return
  pendingRefresh = false
  busy = true
  const revision = generation
  say(
    lastPage ? 'Refreshing… last-known rows retained.' : 'Loading Skillager…',
    lastPage ? 'stale' : 'loading',
  )
  try {
    let page
    if (query) {
      const root =
        context.workspace?.host === 'local' && context.workspace.root?.hostId === 'local'
          ? context.workspace.root.path
          : undefined
      page = searchPage(
        await cli(
          searchArgs(query, {
            ...searchOptions,
            cursor: cursor ?? '',
            ...(root ? { installedProject: root } : {}),
          }),
        ),
      )
    } else if (view === 'project') {
      if (!context.workspace || context.workspace.host !== 'local')
        throw new Error(
          'SSH project presence is unknown. Open Your library for independent local browsing; no remote CLI is run.',
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
      )
      const exposures = projectExposures(
        await cli(
          ['expose', '--list', '--all-agents', '--scope', 'project', '--json'],
          scope(),
        ),
      )
      const paths = new Set(exposures.map((item) => item.path))
      const observed = [
        ...inventory.rows.filter((item) => !paths.has(item.path)),
        ...exposures,
      ]
      const offset = Number(cursor ?? 0)
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
          ...(cursor ? ['--cursor', cursor] : []),
        ]),
      )
    }
    if (available() && generation === revision) rows(page)
  } catch (error) {
    if (available() && generation === revision)
      say(
        `${error.message}${lastPage ? ' · Last-known rows retained; freshness unavailable.' : ''}`,
        lastPage ? 'stale' : 'error',
      )
  } finally {
    busy = false
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
    positions.set(`${detailInput.row.source}:${detailInput.row.path}`, {
      scroll: body.scrollTop,
      mode: body.dataset.mode,
    })
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
    const selected = await client.request('source.select', {
      source: row.source,
      path: {
        hostId: row.source === 'library' ? 'local' : context.workspace?.host,
        path: row.path,
      },
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
      say('Current instructions · viewing grants no acceptance or execution')
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
on('search-form', 'submit', (event) => {
  event.preventDefault()
  query = element('query').value.trim()
  cursor = undefined
  previous = []
  searchOptions = {
    includeInstalled: element('include-installed').checked,
    separateCopies: element('separate-copies').checked,
    preferredAgent: element('preferred-agent').value || undefined,
  }
  requestRefresh()
})
on('browse', 'click', () => {
  query = ''
  cursor = undefined
  previous = []
  element('query').value = ''
  requestRefresh()
})
on('refresh', 'click', () => {
  cursor = undefined
  previous = []
  requestRefresh()
})
on('next', 'click', () => {
  if (!lastPage?.next || busy) return
  previous.push(cursor)
  cursor = lastPage.next
  requestRefresh()
})
on('previous', 'click', () => {
  if (!previous.length || busy) return
  cursor = previous.pop()
  requestRefresh()
})
client.listen((message) => {
  if (message.kind === 'context') {
    const renewed = message.context.visible && !context.visible
    const changed = message.context.workspace?.id !== context.workspace?.id
    context = message.context
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
        pendingSelection = true
        instructionText = ''
        renderedHtml = undefined
        body.replaceChildren()
        const position = positions.get(
          `${detailInput.row.source}:${detailInput.row.path}`,
        )
        body.dataset.mode = position?.mode ?? 'rendered'
        selectedScroll = position?.scroll ?? 0
      }
      if (pendingSelection && available()) void readSelected()
    } else if (renewed || changed) {
      if (changed) {
        cursor = undefined
        previous = []
        if (element('include-installed'))
          element('include-installed').checked =
            context.workspace?.host !== 'local' || !context.workspace.root
      }
      requestRefresh()
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
  },
  { once: true },
)
client.hello()
