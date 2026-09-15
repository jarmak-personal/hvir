import {
  createDirectAddController,
  changeAddChoice,
  addChoice,
  reviewDirectAddSample,
  applyReviewedDirectAddSample,
} from './direct-add.mjs'
import { createCurationActions } from './curation-actions.mjs'
import { createSampleReader, readingView } from './reading.mjs'
import { readingSearchFixture } from './search-sample.mjs'
import {
  curationSample,
  curationSource,
  curationRouter,
  curationTarget,
  syncCurationSample,
  searchCurationSample,
} from './curation-model.mjs'
import { curationDetailView, curationSyncView } from './curation-views.mjs'
const { document, window, setTimeout, clearTimeout, setInterval, clearInterval } =
  globalThis
import {
  initialState,
  destinationFor,
  skillFor,
  exposuresFor,
  sampleSearch,
  previewSnapshot,
  applySample,
  libraries,
  automaticRefreshAllowed,
  skillsVisible,
  beginSampleSetup,
  finishSampleSetup,
  cancelSampleSetup,
  reconcileSampleSetup,
  projectMetadataSample,
  projectSampleFor,
  beginProjectSetupSample,
  completeProjectSetupSample,
  finishProjectTerminalSample,
  refreshProjectSample,
} from './model.mjs'
import {
  connectionView,
  previewView,
  detailView,
  skillsRailView,
  reviewView,
  escapeHtml,
  nativeProjectDetailView,
  projectTerminalView,
} from './views.mjs'
const $ = (selector) => document.querySelector(selector)
let state = initialState(),
  searchTimer,
  refreshTimer,
  setupTimer,
  projectSetupTimer,
  queryGeneration = 0,
  toastTimer,
  periodic
const reader = createSampleReader(() => state, render)
const directAdd = createDirectAddController(() => state, render, notify)
const curate = createCurationActions(() => state, {
  reader,
  render,
  modal,
  closeDialog,
  cancelSearch,
  selectViewer,
  revealSkillInFiles,
  directAdd,
})
function notify(text) {
  if (!state.enabled) return
  clearTimeout(toastTimer)
  $('#toast').textContent = text
  $('#toast').hidden = false
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true
  }, 5000)
}
function cancelSearch() {
  clearTimeout(searchTimer)
  queryGeneration++
  state.searching = false
  state.results = null
  state.submittedQuery = ''
  state.submittedSearch = state.searchReport = null
}
function closeDialog() {
  $('#dialog').close()
  $('#dialog').innerHTML = ''
  state.preview = null
}
function modal(html) {
  $('#dialog').innerHTML = html
  if (!$('#dialog').open) $('#dialog').showModal()
}
function showObservation() {
  for (const button of document.querySelectorAll('.header-refresh')) {
    button.setAttribute('aria-busy', String(!!state.refreshing))
    button.title = state.lastChecked
  }
  if ($('#freshness')) $('#freshness').textContent = state.lastChecked
  if ($('#observation-notice'))
    $('#observation-notice').textContent = state.refreshError
      ? `Stale observation · ${state.refreshError} · Retry with Refresh`
      : ''
}
function refresh() {
  if (!state.connected || !skillsVisible(state)) return
  clearTimeout(refreshTimer)
  const snapshot = state,
    generation = state.generation
  state.refreshing = true
  showObservation()
  refreshTimer = setTimeout(() => {
    if (
      state !== snapshot ||
      generation !== state.generation ||
      !state.connected ||
      !skillsVisible(state)
    )
      return
    state.refreshing = false
    state.refreshError = state.sampleRefreshFailure
      ? 'Refresh unavailable; retained last successful list'
      : null
    if (!state.refreshError) {
      const initial = state.initialLoading
      state.initialLoading = false
      const before = JSON.stringify(projectSampleFor(state))
      refreshProjectSample(state)
      state.lastChecked = `Checked at ${new Date().toLocaleTimeString()} · ${destinationFor(state).label}`
      if (initial || before !== JSON.stringify(projectSampleFor(state))) render()
    }
    showObservation()
  }, state.sampleRefreshDelay ?? 100)
}

function render() {
  reader.remember()
  const focused = document.activeElement,
    row = focused?.closest('.skill-row')
  const addFocus = focused?.closest('.direct-add-controls') ? focused.id : null
  const rowIdentity = row ? JSON.stringify(row.dataset) : null
  const rowButton = row ? [...row.querySelectorAll('button')].indexOf(focused) : -1
  const scrolls = [...document.querySelectorAll('.explorer-scroll')].map(
    (el) => el.scrollTop,
  )
  const focusedSearch = document.activeElement?.id === 'search'
  const selection = focusedSearch
    ? [$('#search').selectionStart, $('#search').selectionEnd]
    : null
  $('#active-workspace').textContent = destinationFor(state).label
  $('#curation-lab').hidden = !state.curation
  $('#project-terminal-lab').hidden = !state.projectStudy
  $('#setup-terminal').hidden = state.selectedTerminal === 'ordinary'
  $('#ordinary-terminal').hidden = state.selectedTerminal !== 'ordinary'
  $('#setup-terminal').innerHTML = projectTerminalView(state)
  $('#setup-terminal-tabs').innerHTML = state.setupTerminals
    .map(
      (terminal) =>
        `<button data-terminal="${terminal.id}">Shell · setup ${terminal.id.slice(6)}</button>`,
    )
    .join('')
  $('#skills-nav-container').innerHTML = state.enabled
    ? '<button id="skills-nav" data-rail="skills">Skills</button>'
    : ''
  $('#skills-tab-container').innerHTML =
    state.enabled && state.skillsOpen
      ? `<button data-viewer="skills">${escapeHtml(state.curation ? (state.curation.selectedRouter ? curationRouter(state).name : curationSource(state).name) : state.nativeSelected || state.selected)}</button><button data-action="close-skills" aria-label="Close skill">×</button>`
      : ''
  for (const viewer of ['skills', 'document', 'history']) {
    $(`#${viewer}-view`).hidden = state.viewer !== viewer
    document
      .querySelectorAll(`[data-viewer="${viewer}"]`)
      .forEach((b) => b.classList.toggle('active', state.viewer === viewer))
  }
  for (const rail of ['files', 'git', 'skills']) {
    $(`#${rail}-rail`).hidden = state.railMode !== rail
    document
      .querySelectorAll(`[data-rail="${rail}"]`)
      .forEach((b) => b.classList.toggle('active', state.railMode === rail))
  }
  $('#skills-rail').innerHTML = skillsRailView(state)
  $('#polish-refresh-error').checked = !!state.sampleRefreshFailure
  $('#polish-uncertain').checked = state.sampleDirectOutcome === 'uncertain'
  $('#polish-prerequisites').checked = !!state.samplePrerequisites?.length
  $('#reading-delay').checked = state.sampleReadDelay === 500
  $('#reading-count').textContent = `${state.readCount || 0} explicit sample reads`
  $('#skills-view').innerHTML =
    state.enabled && state.connected && state.skillsOpen
      ? state.curation
        ? curationDetailView(state)
        : state.nativeSelected
          ? nativeProjectDetailView(state)
          : state.reviewOpen
            ? reviewView(state)
            : `<article class="details" id="details">${detailView(state)}</article>`
      : ''
  if (state.enabled && state.connected && state.skillsOpen && !state.reviewOpen)
    ($('#skills-view .source-status') || $('#skills-view .details'))?.insertAdjacentHTML(
      $('#skills-view .source-status') ? 'beforebegin' : 'afterend',
      readingView(state),
    )
  reader.restore()
  document.querySelectorAll('.explorer-scroll').forEach((el, i) => {
    el.scrollTop = scrolls[i] || 0
  })
  if (rowIdentity && rowButton >= 0)
    [...document.querySelectorAll('.skill-row')]
      .find((item) => JSON.stringify(item.dataset) === rowIdentity)
      ?.querySelectorAll('button')
      [rowButton]?.focus({ preventScroll: true })
  if (addFocus) document.getElementById(addFocus)?.focus({ preventScroll: true })
  syncRefreshDemand()
  if (focusedSearch && $('#search')) {
    $('#search').focus()
    $('#search').setSelectionRange(...selection)
  }
}
function selectViewer(viewer, read = false) {
  if (viewer === 'skills' && (!state.enabled || !state.skillsOpen)) return
  closeDialog()
  state.viewer = viewer
  directAdd.revoke()
  if (viewer !== 'skills') {
    reader.revoke()
  } else if (read) {
    state.reviewOpen = false
    reader.activate()
  }
  if (viewer !== 'skills') state.lastOrdinaryViewer = viewer
  refresh()
  render()
}
function selectRail(rail) {
  if (rail === 'skills' && !state.enabled) return
  if (rail !== 'skills') cancelSearch()
  state.railMode = rail
  refresh()
  render()
}
function revokeFeature() {
  clearTimeout(refreshTimer)
  state.refreshing = false
  directAdd.revoke()
  reader.revoke()
  cancelSampleSetup(state)
  clearTimeout(setupTimer)
  clearTimeout(projectSetupTimer)
  state.pendingProjectSetup = null
  state.nativeSelected = null
  state.connected = false
  state.generation++
  cancelSearch()
  clearInterval(periodic)
  periodic = undefined
  clearTimeout(toastTimer)
  $('#toast').hidden = true
  $('#toast').textContent = ''
  closeDialog()
  state.skillsOpen = false
  state.reviewOpen = false
  state.query = ''
  if (state.viewer === 'skills') state.viewer = state.lastOrdinaryViewer
  if (state.railMode === 'skills') state.railMode = 'files'
}
function search(legacy = false) {
  if (!state.enabled || !state.connected || state.railMode !== 'skills') return
  cancelSearch()
  state.query = $('#search').value
  state.scope = $('#search-scope').value
  state.submittedQuery = state.query
  state.searching = true
  state.results = []
  const generation = queryGeneration
  const submitted = {
    query: state.query,
    scope: state.scope,
    agent: state.browseAgent,
    includeInstalled: state.includeInstalled,
    showCopies: state.showCopies,
    legacy,
  }
  state.submittedSearch = submitted
  render()
  $('#search').focus()
  searchTimer = setTimeout(() => {
    if (
      generation !== queryGeneration ||
      !state.enabled ||
      !state.connected ||
      state.railMode !== 'skills'
    )
      return
    state.searchReport = state.curation
      ? searchCurationSample(state, submitted)
      : sampleSearch({ ...state, ...submitted })
    state.results = state.searchReport.rows
    state.searching = false
    render()
  }, 500)
}
function prepare(action, mode) {
  state.preview = previewSnapshot(
    state,
    action,
    mode || exposuresFor(state)[state.selected]?.mode || 'native',
  )
  modal(previewView(state, state.preview))
}
function action(name) {
  if (name === 'close') return closeDialog()
  if (name === 'settings') return modal(connectionView(state))
  if (name === 'files-trash' && state.filesSelection) {
    return modal(
      `<h2 id="dialog-title">Move to Trash</h2><p>Local · ${state.filesSelection.path}</p><p>This local folder can be recovered from Trash.</p><footer><button data-action="close">Cancel</button><button data-action="files-trash-confirm">Move to Trash</button></footer>`,
    )
  }
  if (name === 'files-trash-confirm' && state.filesSelection) {
    state.filesSelection.source.projectPresent = false
    $('#files-selection').innerHTML =
      '<p>Moved selected folder to Trash · local sample.</p>'
    closeDialog()
    return render()
  }
  if (!state.enabled) return
  if (name === 'check-again') {
    // Simulate a read-only probe of externally controlled fixture availability.
    state.missing = !state.sampleCliAvailable
    render()
    if ($('#dialog').open) modal(connectionView(state))
    return
  }
  if (name === 'show-setup') {
    closeDialog()
    return selectRail('skills')
  }
  if (name === 'choose-folder' && state.libraryMissing && state.setup.status === 'idle')
    return modal(
      `<h2 id="dialog-title">Choose a local folder · sample picker</h2><p>This offline picker changes only the displayed sample location.</p><label>Folder<select id="sample-folder"><option>/home/example/.skillager/library</option><option>/home/example/Documents/my-skills</option></select></label><footer>${'<button data-action="close">Cancel</button><button data-action="use-folder">Choose folder</button>'}</footer>`,
    )
  if (name === 'use-folder' && state.libraryMissing && state.setup.status === 'idle') {
    state.setup.path = $('#sample-folder').value
    closeDialog()
    return render()
  }
  if (name === 'cancel-setup') {
    cancelSampleSetup(state)
    clearTimeout(setupTimer)
    state.generation++
    return render()
  }
  if (name === 'check-setup') {
    reconcileSampleSetup(state)
    return render()
  }
  if (name === 'close-skills') {
    state.skillsOpen = false
    state.reviewOpen = false
    return selectViewer(state.lastOrdinaryViewer)
  }
  if (name === 'connect' && !state.missing && !state.libraryMissing) {
    state.connected = true
    state.generation++
    closeDialog()
    refresh()
    return render()
  }
  if (name === 'change-library') {
    state.library = state.library.id === libraries[0].id ? libraries[1] : libraries[0]
    revokeFeature()
    render()
    return modal(connectionView(state))
  }
  if (!state.connected) return
  if (name === 'native-files' && state.nativeFileSelection)
    return revealSkillInFiles(state.nativeFileSelection)
  if (name === 'sync-approved') {
    return modal(curationSyncView(state))
  }
  if (name === 'show-project-setup') {
    state.setupOpen = true
    return render()
  }
  if (name === 'project-setup') {
    const handoff = beginProjectSetupSample(state)
    if (!handoff) return
    render()
    projectSetupTimer = setTimeout(() => {
      completeProjectSetupSample(state, handoff)
      render()
    }, 400)
    return
  }
  if (name === 'metadata') {
    state.selectedSearchVersion = null
    return selectViewer('skills', true)
  }
  if (name === 'include-installed') {
    state.includeInstalled = true
    return search()
  }
  if (name === 'legacy-search') return search(true)
  if (name === 'canonical-definition') {
    reader.revoke()
    state.selectedSearchVersion = null
    if (state.curation) state.curation.selectedScope = 'library'
    else state.selectedScope = 'library'
    return selectViewer('skills', true)
  }
  if (name === 'refresh') return refresh()
  if (name === 'cancel-search') {
    cancelSearch()
    return render()
  }
  if (name === 'add') {
    closeDialog()
    cancelSearch()
    return directAdd.start({ agent: state.agent, mode: 'native' })
  }
  if (name === 'review-add') {
    state.preview = reviewDirectAddSample(state)
    if (state.preview) return modal(previewView(state, state.preview))
    return
  }
  if (
    name === 'inspect-add' &&
    state.directAddUncertain?.destination === state.destination
  ) {
    const plan = state.directAddUncertain
    state.filesSelection = null
    $('#files-selection').innerHTML =
      `<p>Inspect ${escapeHtml(plan.destinationHost)} · ${escapeHtml(plan.targetPath)}</p><p>Add completion remains uncertain. Observing files does not prove this operation completed; no retry or removal was authorized.</p>`
    return selectRail('files')
  }
  if (name === 'preview-add') {
    cancelSearch()
    const { destination, agent, mode } = addChoice(state)
    if (state.destination !== destination || state.agent !== agent) {
      reader.revoke()
      state.generation++
    }
    state.destination = destination
    state.agent = agent
    if (destinationFor(state).host !== 'local') state.scope = 'personal'
    render()
    closeDialog()
    return directAdd.start({ agent: state.agent, mode })
  }
  if (name === 'switch')
    return prepare(
      'switch',
      exposuresFor(state)[state.selected].mode === 'native' ? 'stub' : 'native',
    )
  if (['update', 'remove', 'accept'].includes(name)) return prepare(name)
  if (name === 'read') {
    reader.revoke()
    closeDialog()
    state.reviewOpen = true
    state.skillsOpen = true
    return selectViewer('skills')
  }
  if (name === 'history')
    return modal(
      '<h2 id="dialog-title">Version history · metadata only</h2><p>Current accepted version and prior versions belong to Skillager.</p><p>Libraries without Git show history unavailable. A new draft has no previous version: review the full tree explicitly.</p><footer><button data-action="close">Close</button></footer>',
    )
  if (name === 'apply' && state.preview) {
    const requested = state.preview.action,
      destination = destinationFor(state).label
    const result = state.preview.createOnly
      ? applyReviewedDirectAddSample(state, state.preview)
      : applySample(state, state.preview)
    if (result !== 'completed')
      return modal(
        `<h2 id="dialog-title">${result === 'stale' ? 'This preview is out of date' : 'Preserve this target'}</h2><p>No action applied. Refresh and review a new preview.</p><footer><button data-action="close">Close</button></footer>`,
      )
    closeDialog()
    cancelSearch()
    refresh()
    notify(
      requested === 'accept'
        ? 'Accepted library version. Workspace copies were not updated.'
        : requested === 'remove'
          ? `Removed exposure from ${destination}. Library original and other workspaces kept.`
          : `${requested === 'add' ? 'Added' : 'Updated'} · ${destination} · ${state.agent}`,
    )
    render()
  }
}
function revealSkillInFiles(source) {
  state.filesSelection = { host: 'local', path: curationTarget(state, source), source }
  closeDialog()
  $('#files-selection').innerHTML =
    `<p>Selected folder · Local · ${state.filesSelection.path}</p><p>◇ SKILL.md · use the existing Files viewer for content</p><button data-action="files-trash">Move to Trash…</button>`
  return selectRail('files')
}

function scenario(name) {
  clearTimeout(refreshTimer)
  directAdd.revoke()
  reader.revoke()
  $('#files-selection').innerHTML = ''
  clearTimeout(toastTimer)
  clearTimeout(setupTimer)
  clearTimeout(projectSetupTimer)
  $('#toast').hidden = true
  cancelSearch()
  closeDialog()
  state = initialState()
  if (name !== 'disabled') {
    state.enabled = true
    state.connected = true
    state.railMode = 'skills'
    state.viewer = 'skills'
    state.skillsOpen = true
    state.lastChecked = 'Just checked · active workspace'
  }
  if (['missing', 'cli-available'].includes(name)) {
    state.missing = true
    state.sampleCliAvailable = name === 'cli-available'
    state.connected = false
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
  }
  if (
    [
      'setup',
      'setup-error',
      'setup-git-mismatch',
      'setup-remote',
      'setup-status-unavailable',
    ].includes(name)
  ) {
    state.libraryMissing = true
    state.connected = false
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
    if (name === 'setup-error') state.sampleSetupOutcome = 'error'
    if (name === 'setup-status-unavailable') state.sampleSetupStatusUnavailable = true
    if (name === 'setup-git-mismatch') state.sampleSetupOutcome = 'git-mismatch'
    if (name === 'setup-remote') {
      state.destination = 'remote-main'
      state.scope = 'personal'
    }
  }
  if (name === 'initial-loading') {
    state.initialLoading = true
    state.sampleRefreshDelay = 450
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
  }
  if (name === 'empty') {
    state.empty = true
    state.skills = []
    state.exposures = {}
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
  }
  if (['project-existing', 'project-empty', 'project-unavailable'].includes(name)) {
    state.projectStudy = true
    state.perspective = 'workspace'
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
    for (const destination of ['local-main', 'local-review'])
      for (const agent of ['codex', 'claude']) {
        const sample = projectMetadataSample()
        if (name !== 'project-existing') sample.rows = sample.externalRows = []
        if (name === 'project-unavailable') {
          sample.metadataUnavailable = true
          sample.external = sample.observed = { state: 'Unavailable', working: 'Unknown' }
        }
        state.projectSamples[`${destination}/${agent}`] = sample
      }
  }
  if (
    ['curation', 'reading-search', 'reading-legacy', 'reading-unknown'].includes(name)
  ) {
    state.curation = curationSample()
    if (name.startsWith('reading-')) {
      readingSearchFixture(state.curation)
      state.searchOpen = state.advancedOpen = true
      state.searchContract = name !== 'reading-legacy'
      state.presenceUnknown = name === 'reading-unknown'
    }
    state.perspective = 'workspace'
    state.scope = 'available'
    state.skillsOpen = false
    state.viewer = state.lastOrdinaryViewer
  }
  if (name === 'unavailable')
    state.lastChecked = 'Unavailable · last checked 4 minutes ago'
  if (name === 'remote') {
    state.scope = 'personal'
    state.destination = 'remote-main'
    state.selected = 'incident-notes'
  }
  if (name === 'add') state.selected = 'incident-notes'
  if (name === 'pending') state.selected = 'deploy-checklist'
  if (['switch', 'remove'].includes(name)) {
    state.selected = 'pr-review'
    exposuresFor(state)['pr-review'].mode = 'native'
  }
  if (['modified', 'pinned', 'unmanaged', 'blocked'].includes(name)) {
    state.perspective = 'workspace'
    state.selected = name === 'pinned' ? 'test-design' : 'release-checklist'
    if (name === 'unmanaged') {
      delete exposuresFor(state)[state.selected]
      state.unmanagedTargets['local-main/codex'] = { [state.selected]: true }
    } else if (name === 'blocked') {
      delete exposuresFor(state)[state.selected].protected
      skillFor(state).blocked = true
    }
  }
  if (name === 'notify') {
    skillFor(state, 'pr-review').version = 'd777a09'
    state.perspective = 'workspace'
  }
  if (name === 'search') {
    state.includeInstalled = true
    state.searchOpen = true
    state.query = 'deadlock'
    state.scope = 'available'
  }
  render()
  if (name === 'search') search()
  if (name === 'initial-loading') refresh()
  if (['add', 'remote'].includes(name)) {
    state.selectedScope = 'library'
    reader.activate()
    render()
  }
  if (name === 'switch') prepare('switch', 'stub')
  if (name === 'remove') prepare('remove')
  if (name === 'pending') prepare('accept')
  if (['update', 'stale'].includes(name)) prepare('update')
  // Simulate an accepted source changing after preview, exercising the real version guard.
  if (name === 'stale') skillFor(state).version = 'newer-a72c'
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button || button.disabled) return
  if (button.dataset.terminal) {
    state.selectedTerminal = button.dataset.terminal
    return render()
  }
  if (button.dataset.reading) return reader.control(button.dataset.reading)
  if (button.dataset.curate) return curate(button.dataset.curate)
  if (button.dataset.action) return action(button.dataset.action)
  if (button.dataset.rail) return selectRail(button.dataset.rail)
  if (button.dataset.viewer) return selectViewer(button.dataset.viewer, true)
  if (!state.enabled || !state.connected) return
  if (button.dataset.perspective) {
    const scope = button.dataset.perspective
    if (state.results || state.searching) {
      cancelSearch()
      state.explorerOpen[scope] = true
    } else state.explorerOpen[scope] = !state.explorerOpen[scope]
    return render()
  }
  if (button.dataset.expand) {
    state.expandedSkills[button.dataset.expand] =
      !state.expandedSkills[button.dataset.expand]
    return render()
  }
  if (
    button.matches(
      '[data-select],[data-native],[data-curation-select],[data-curation-router],[data-menu],[data-curation-menu],[data-router-menu]',
    )
  ) {
    directAdd.revoke()
    reader.revoke()
    const result = state.results?.find((row) =>
      row.occurrenceId
        ? row.occurrenceId === button.dataset.occurrence
        : row.id === button.dataset.select,
    )
    state.selectedSearchVersion = result?.sourceVersion || null
  }
  const rowScope = button.closest('[data-row-scope]')?.dataset.rowScope
  if (rowScope) {
    state.perspective = rowScope
    state.selectedScope = rowScope
  }
  if (button.dataset.routerMenu) {
    state.curation.routerId = button.dataset.routerMenu
    curate('select-router')
    return curate('router-menu')
  }
  if (button.dataset.curationRouter) {
    state.curation.routerId = button.dataset.curationRouter
    curate('select-router')
    reader.activate()
    return render()
  }
  if (button.dataset.curationSelect || button.dataset.curationMenu) {
    state.curation.selectedMemberRouter = button.dataset.memberRouter || null
    state.curation.selectedScope = rowScope ?? 'workspace'
    state.curation.selected = button.dataset.curationSelect || button.dataset.curationMenu
    state.curation.selectedRouter = false
    state.reviewOpen = false
    state.skillsOpen = true
    selectViewer('skills', !!button.dataset.curationSelect)
    if (button.dataset.curationMenu) curate('menu')
    return
  }
  if (button.dataset.nativeFilesId) {
    state.nativeFileSelection = projectSampleFor(state).rows.find(
      (row) => row.id === button.dataset.nativeFilesId,
    )
    return action('native-files')
  }
  if (button.dataset.nativeActions) {
    state.nativeFileSelection = projectSampleFor(state).rows.find(
      (row) => row.id === button.dataset.nativeActions,
    )
    return modal(
      `<h2 id="dialog-title">Actions · ${escapeHtml(button.dataset.nativeActions)}</h2><p>Preserve an approved version in your personal library before converting this project source.</p><button disabled>Use as full skill…</button><button disabled>Use as stub…</button><button disabled>Group in router</button><p>Use Sync approved skills after approval. Unrepresented files and modified targets stay protected.</p><button data-action="native-files">Review or remove in Files…</button><footer><button data-action="close">Close</button></footer>`,
    )
  }
  if (button.dataset.native) {
    state.nativeSelected = button.dataset.native
    state.skillsOpen = true
    state.reviewOpen = false
    state.selectedSearchVersion = null
    return selectViewer('skills', true)
  }
  if (button.dataset.rowAgent) state.agent = button.dataset.rowAgent
  if (button.dataset.select) {
    state.nativeSelected = null
    state.selected = button.dataset.select
    state.reviewOpen = false
    state.skillsOpen = true
    return selectViewer('skills', true)
  }
  if (button.dataset.menu) {
    state.selected = button.dataset.menu
    state.reviewOpen = false
    render()
    return modal(
      `<h2 id="dialog-title">Actions · ${state.selected}</h2>${detailView(state, true)}<footer><button data-action="close">Close</button></footer>`,
    )
  }
})
document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest(
    '[data-skill], [data-curation-row], [data-library-row], [data-native-row], [data-router-row]',
  )
  if (!row || !state.enabled || !state.connected) return
  const trigger = row.querySelector(
    '[data-menu], [data-curation-menu], [data-native-actions], [data-router-menu]',
  )
  if (!trigger) return
  event.preventDefault()
  trigger.click()
})
document.addEventListener('submit', (event) => {
  if (event.target.id === 'library-setup') {
    event.preventDefault()
    const generation = beginSampleSetup(state)
    if (generation === undefined) return
    render()
    setupTimer = setTimeout(() => {
      finishSampleSetup(state, generation)
      render()
    }, 600)
  }
  if (event.target.id === 'search-form') {
    event.preventDefault()
    search()
  }
})
document.addEventListener('change', (event) => {
  if (event.target.id === 'enabled') {
    const enabled = event.target.checked
    revokeFeature()
    state.enabled = enabled
    render()
    return modal(connectionView(state))
  }
  if (!state.enabled) return
  if ($('#search-disclosure')) state.searchOpen = $('#search-disclosure').open
  if ($('#search-advanced')) state.advancedOpen = $('#search-advanced').open
  if (event.target.id === 'library-git') state.setup.git = event.target.checked
  if (['destination', 'agent'].includes(event.target.id)) {
    directAdd.revoke()
    reader.revoke()
    state.selectedSearchVersion = null
    clearTimeout(projectSetupTimer)
    state.pendingProjectSetup = null
    state.nativeSelected = null
    if (state.projectStudy) {
      state.skillsOpen = false
      state.viewer = state.lastOrdinaryViewer
    }
    cancelSearch()
    closeDialog()
    state[event.target.id] = event.target.value
    state.generation++
    if (destinationFor(state).host !== 'local') state.scope = 'personal'
    refresh()
    render()
  }
  if (event.target.id === 'curation-group') {
    const group = state.curation.routers.find(
      (router) => router.id === event.target.value,
    )
    $('#curation-name').disabled = !!group
    $('#router-existing-members').textContent = group
      ? `Existing members: ${group.members.map((id) => curationSource(state, id).name).join(', ')}`
      : 'New group; no existing members.'
  }
  if (event.target.id === 'browse-agent') {
    state.browseAgent = event.target.value
    return render()
  }
  if (event.target.id === 'filter') {
    cancelSearch()
    state.filter = event.target.value
    render()
  }
  if (['include-installed', 'show-copies'].includes(event.target.id)) {
    state[event.target.id === 'include-installed' ? 'includeInstalled' : 'showCopies'] =
      event.target.checked
  }
  if (event.target.id === 'search-scope') {
    state.scope = event.target.value
    render()
  }
  if (
    !event.target.closest('dialog') &&
    changeAddChoice(state, event.target.id, event.target.value)
  )
    render()
})
document.addEventListener(
  'toggle',
  (event) => {
    if (!event.target.isConnected) return
    if (event.target.id === 'search-disclosure') state.searchOpen = event.target.open
    if (event.target.id === 'search-advanced') state.advancedOpen = event.target.open
  },
  true,
)
document.addEventListener('input', (event) => {
  if (event.target.id === 'search') state.query = event.target.value
})
document.addEventListener('keydown', (event) => {
  if (
    state.enabled &&
    event.key === '/' &&
    !event.target.matches('input,select,textarea') &&
    !$('#dialog').open
  ) {
    event.preventDefault()
    state.searchOpen = true
    selectRail('skills')
    $('#search')?.focus()
  }
})
$('#dialog').addEventListener('cancel', () => {
  state.preview = null
})
$('#settings').onclick = () => action('settings')
$('#reset').onclick = () => {
  $('#scenario').value = 'disabled'
  scenario('disabled')
}
$('#scenario').onchange = (event) => scenario(event.target.value)
$('#curation-long-project').onclick = () => {
  if (!state.enabled || !state.curation) return
  if (state.curation.sources.some((row) => row.id === 'observed-0')) return
  const example = curationSource(state, 'draft')
  for (let i = 0; i < 40; i++)
    state.curation.sources.push({
      ...example,
      id: `observed-${i}`,
      name: `Observed project skill ${i}`,
    })
  render()
}
$('#polish-refresh').onclick = () => {
  state.sampleRefreshDelay = 450
  refresh()
}
$('#polish-refresh-error').onchange = (event) => {
  state.sampleRefreshFailure = event.target.checked
}
$('#polish-prerequisites').onchange = (event) => {
  state.samplePrerequisites = event.target.checked ? ['Python 3.12'] : []
  render()
}
$('#polish-uncertain').onchange = (event) => {
  state.sampleDirectOutcome = event.target.checked ? 'uncertain' : null
}
$('#polish-theme').onchange = (event) => {
  document.documentElement.dataset.studyTheme = event.target.value
}
$('#reading-delay').onchange = (event) => {
  state.sampleReadDelay = event.target.checked ? 500 : 25
}
$('#curation-change-source').onclick = () => {
  if (state.enabled && state.curation) {
    const row = curationSource(state)
    row.version = row.version === 'newer-v2' ? 'newer-v3' : 'newer-v2'
  }
}
$('#curation-block-origin').onclick = () => {
  if (state.enabled && state.curation) curationSource(state).originBlocked = true
}
$('#curation-edit-library').onclick = () => {
  if (state.enabled && state.curation) {
    const row = curationSource(state)
    row.libraryVersion = 'edited-v3'
    row.libraryAccepted = false
    render()
  }
}
$('#curation-change-router').onclick = () => {
  if (state.enabled && state.curation) curationRouter(state).version++
}
$('#curation-shared-tag').onclick = () => {
  if (state.enabled && state.curation) curationRouter(state).shared = true
}
$('#curation-interrupt-sync').onclick = () => {
  if (state.enabled && state.curation) state.curation.interruptSync = true
}
$('#curation-interrupt').onclick = () => {
  if (state.enabled && state.curation) state.curation.nextUncertain = true
}
$('#curation-unsupported').onclick = () => {
  if (state.enabled && state.curation) {
    state.curation.unavailable = true
    render()
  }
}
$('#curation-approve').onclick = () => {
  if (!state.enabled || !state.curation) return
  curationSource(state, 'draft').approved = true
  syncCurationSample(state)
  state.curation.lastEffect =
    'Explicit source approval completed; library sync outcomes are available. No workspace conversion ran.'
  render()
}
$('#finish-project-terminal').onclick = () => {
  finishProjectTerminalSample(state, $('#project-outcome').value)
  render()
}
$('#recover-project-terminal').onclick = () => {
  // Simulate ordinary terminal recovery with the one-shot setup command omitted.
  const terminal = state.setupTerminals.find((t) => t.id === state.selectedTerminal)
  if (terminal) {
    terminal.running = false
    terminal.recovered = true
  }
  render()
}
function refreshIfActive() {
  if (
    automaticRefreshAllowed(
      state,
      document.visibilityState === 'visible',
      document.hasFocus(),
    )
  )
    refresh()
}
function syncRefreshDemand() {
  const active = automaticRefreshAllowed(
    state,
    document.visibilityState === 'visible',
    document.hasFocus(),
  )
  if (active && !periodic) periodic = setInterval(refreshIfActive, 60_000)
  if (!skillsVisible(state)) {
    clearTimeout(refreshTimer)
    state.refreshing = false
  }
  if (!active && periodic) {
    clearInterval(periodic)
    periodic = undefined
  }
}
function visibilityChanged() {
  syncRefreshDemand()
  refreshIfActive()
}
document.addEventListener('visibilitychange', visibilityChanged)
window.addEventListener('focus', visibilityChanged)
window.addEventListener('blur', syncRefreshDemand)
window.addEventListener('pagehide', () => {
  revokeFeature()
  render()
})
render()
