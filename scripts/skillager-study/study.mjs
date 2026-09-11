const { document, window, setTimeout, clearTimeout, setInterval, clearInterval } =
  globalThis
import {
  initialState,
  destinations,
  destinationFor,
  skillFor,
  exposuresFor,
  sampleSearch,
  previewSnapshot,
  applySample,
  libraries,
  automaticRefreshAllowed,
  skillsVisible,
} from './model.mjs'
import {
  connectionView,
  pickerView,
  previewView,
  detailView,
  skillsRailView,
  reviewView,
  escapeHtml,
} from './views.mjs'
const $ = (selector) => document.querySelector(selector)
let state = initialState(),
  preview,
  searchTimer,
  queryGeneration = 0,
  toastTimer,
  periodic
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
}
function closeDialog() {
  $('#dialog').close()
  $('#dialog').innerHTML = ''
  preview = null
}
function modal(html) {
  $('#dialog').innerHTML = html
  if (!$('#dialog').open) $('#dialog').showModal()
}
function refresh() {
  if (!state.connected || !skillsVisible(state)) return
  state.lastChecked = `Checked at ${new Date().toLocaleTimeString()} · ${destinationFor(state).label}`
  render()
}
function render() {
  const focusedSearch = document.activeElement?.id === 'search'
  const selection = focusedSearch
    ? [$('#search').selectionStart, $('#search').selectionEnd]
    : null
  $('#active-workspace').textContent = destinationFor(state).label
  $('#skills-nav-container').innerHTML = state.enabled
    ? '<button id="skills-nav" data-rail="skills">Skills</button>'
    : ''
  $('#skills-tab-container').innerHTML =
    state.enabled && state.skillsOpen
      ? `<button data-viewer="skills">${escapeHtml(state.selected)}</button><button data-action="close-skills" aria-label="Close skill">×</button>`
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
  $('#skills-view').innerHTML =
    state.enabled && state.connected && state.skillsOpen
      ? state.reviewOpen
        ? reviewView(state)
        : `<article class="details" id="details">${detailView(state)}</article>`
      : ''
  document
    .querySelectorAll('[data-perspective]')
    .forEach((b) =>
      b.classList.toggle('active', b.dataset.perspective === state.perspective),
    )
  syncRefreshDemand()
  if (focusedSearch && $('#search')) {
    $('#search').focus()
    $('#search').setSelectionRange(...selection)
  }
}
function selectViewer(viewer) {
  if (viewer === 'skills' && (!state.enabled || !state.skillsOpen)) return
  closeDialog()
  state.viewer = viewer
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
function search() {
  if (!state.enabled || !state.connected || state.railMode !== 'skills') return
  cancelSearch()
  state.query = $('#search').value
  state.scope = $('#search-scope').value
  state.submittedQuery = state.query
  state.searching = true
  state.results = []
  const generation = queryGeneration
  const submitted = { query: state.query, scope: state.scope }
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
    state.results = sampleSearch({ ...state, ...submitted })
    state.searching = false
    render()
  }, 500)
}
function prepare(action, mode) {
  preview = previewSnapshot(
    state,
    action,
    mode || exposuresFor(state)[state.selected]?.mode || 'native',
  )
  modal(previewView(state, preview))
}
function action(name) {
  if (name === 'close') return closeDialog()
  if (name === 'settings') return modal(connectionView(state))
  if (!state.enabled) return
  if (name === 'close-skills') {
    state.skillsOpen = false
    state.reviewOpen = false
    return selectViewer(state.lastOrdinaryViewer)
  }
  if (name === 'connect' && !state.missing) {
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
  if (name === 'metadata') {
    state.reviewOpen = false
    return render()
  }
  if (name === 'refresh') return refresh()
  if (name === 'cancel-search') {
    cancelSearch()
    return render()
  }
  if (name === 'add') return modal(pickerView(state))
  if (name === 'preview-add') {
    cancelSearch()
    state.destination = $('#add-destination').value
    state.agent = $('#add-agent').value
    const selectedMode = $('#add-mode').value
    if (destinationFor(state).host !== 'local') state.scope = 'personal'
    state.generation++
    render()
    return prepare('add', selectedMode)
  }
  if (name === 'switch')
    return prepare(
      'switch',
      exposuresFor(state)[state.selected].mode === 'native' ? 'stub' : 'native',
    )
  if (['update', 'remove', 'accept'].includes(name)) return prepare(name)
  if (name === 'read') {
    closeDialog()
    state.reviewOpen = true
    state.skillsOpen = true
    return selectViewer('skills')
  }
  if (name === 'history')
    return modal(
      '<h2 id="dialog-title">Version history · metadata only</h2><p>Current accepted version and prior versions belong to Skillager.</p><p>Libraries without Git show history unavailable. A new draft has no previous version: review the full tree explicitly.</p><footer><button data-action="close">Close</button></footer>',
    )
  if (name === 'apply' && preview) {
    const requested = preview.action,
      destination = destinationFor(state).label
    const result = applySample(state, preview)
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
function scenario(name) {
  clearTimeout(toastTimer)
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
  if (name === 'missing') {
    state.missing = true
    state.connected = false
  }
  if (name === 'empty') state.empty = true
  if (name === 'unavailable')
    state.lastChecked = 'Unavailable · last checked 4 minutes ago'
  if (name === 'remote') {
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
    state.query = 'deadlock'
    state.scope = 'available'
  }
  render()
  if (name === 'search') search()
  if (['add', 'remote'].includes(name)) action('add')
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
  if (button.dataset.action) return action(button.dataset.action)
  if (button.dataset.rail) return selectRail(button.dataset.rail)
  if (button.dataset.viewer) return selectViewer(button.dataset.viewer)
  if (!state.enabled || !state.connected) return
  if (button.dataset.perspective) {
    cancelSearch()
    state.perspective = button.dataset.perspective
    return render()
  }
  if (button.dataset.select) {
    state.selected = button.dataset.select
    state.reviewOpen = false
    state.skillsOpen = true
    return selectViewer('skills')
  }
  if (button.dataset.menu) {
    state.selected = button.dataset.menu
    state.reviewOpen = false
    render()
    return modal(
      `<h2 id="dialog-title">Actions · ${state.selected}</h2>${detailView(state)}<footer><button data-action="close">Close</button></footer>`,
    )
  }
})
document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('[data-skill]')
  if (!row) return
  event.preventDefault()
  row.querySelector('[data-menu]').click()
})
document.addEventListener('submit', (event) => {
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
  if (['destination', 'agent'].includes(event.target.id)) {
    cancelSearch()
    closeDialog()
    state[event.target.id] = event.target.value
    state.generation++
    if (destinationFor(state).host !== 'local') state.scope = 'personal'
    refresh()
    render()
  }
  if (event.target.id === 'filter') {
    cancelSearch()
    state.filter = event.target.value
    render()
  }
  if (event.target.id === 'search-scope') {
    cancelSearch()
    state.scope = event.target.value
    render()
  }
  if (event.target.id === 'add-destination') {
    const d = destinations.find((d) => d.id === event.target.value)
    const stub = $('#add-mode option[value="stub"]')
    stub.disabled = d.host !== 'local'
    if (stub.disabled) $('#add-mode').value = 'native'
    $('#add-route').textContent =
      `Local · ${state.library.path} → ${d.label}${stub.disabled ? ' · Remote Stub unavailable' : ''}`
  }
})
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
    selectRail('skills')
    $('#search')?.focus()
  }
})
$('#dialog').addEventListener('cancel', () => {
  preview = null
})
$('#settings').onclick = () => action('settings')
$('#reset').onclick = () => {
  $('#scenario').value = 'disabled'
  scenario('disabled')
}
$('#scenario').onchange = (event) => scenario(event.target.value)
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
