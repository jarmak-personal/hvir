const { document, window, setTimeout, clearTimeout, setInterval, clearInterval } =
  globalThis
import {
  initialState,
  destinations,
  destinationFor,
  skillFor,
  exposuresFor,
  statusFor,
  sampleSearch,
  previewSnapshot,
  applySample,
  library,
} from './model.mjs'
import {
  catalogView,
  connectionView,
  pickerView,
  previewView,
  detailView,
  sampleDiff,
  escapeHtml,
} from './views.mjs'
const $ = (selector) => document.querySelector(selector)
let state = initialState(),
  preview,
  searchTimer,
  queryGeneration = 0,
  toastTimer
function notify(text) {
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
}
function closeDialog() {
  $('#dialog').close()
  preview = null
}
function modal(html) {
  $('#dialog').innerHTML = html
  if (!$('#dialog').open) $('#dialog').showModal()
}
function refresh() {
  if (!state.connected || state.viewer !== 'skills') return
  state.lastChecked = 'Just checked · active workspace'
  render()
}
function render() {
  const focusedSearch = document.activeElement?.id === 'search'
  const selection = focusedSearch
    ? [$('#search').selectionStart, $('#search').selectionEnd]
    : null
  for (const viewer of ['skills', 'document', 'history']) {
    $(`#${viewer}-view`).hidden = state.viewer !== viewer
    document
      .querySelectorAll(`[data-viewer="${viewer}"]`)
      .forEach((b) => b.classList.toggle('active', state.viewer === viewer))
  }
  $('#skills-tab-container').hidden = !state.skillsOpen
  $('#connection-label').textContent = state.connected
    ? 'Local Skillager connected'
    : state.enabled
      ? 'Skillager disconnected'
      : 'Skillager disabled'
  $('#destination').value = state.destination
  $('#agent').value = state.agent
  $('#library-nav').classList.toggle('active', state.perspective === 'library')
  $('#workspace-nav').classList.toggle('active', state.perspective === 'workspace')
  const updates = state.skills.filter(
    (s) => statusFor(s, exposuresFor(state)[s.id]) === 'Workspace copy behind',
  ).length
  $('#updates-count').textContent = state.connected
    ? `${updates} workspace update${updates === 1 ? '' : 's'}`
    : ''
  $('#content').innerHTML = catalogView(state)
  if (focusedSearch && $('#search')) {
    $('#search').focus()
    $('#search').setSelectionRange(...selection)
  }
}
function selectViewer(viewer) {
  cancelSearch()
  closeDialog()
  state.viewer = viewer
  if (viewer === 'skills') {
    state.skillsOpen = true
    refresh()
  }
  render()
}
function search() {
  cancelSearch()
  state.query = $('#search').value
  state.scope = $('#search-scope').value
  state.searching = true
  state.results = []
  const generation = queryGeneration
  const submitted = { query: state.query, scope: state.scope }
  render()
  $('#search').focus()
  searchTimer = setTimeout(() => {
    if (generation !== queryGeneration || !state.connected || state.viewer !== 'skills')
      return
    state.results = sampleSearch({ ...state, ...submitted })
    state.searching = false
    if (state.results.length) state.selected = state.results[0].id
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
  if (name === 'connect') {
    state.connected = true
    state.generation++
    closeDialog()
    refresh()
    return render()
  }
  if (name === 'change-library') {
    state.changedLibrary = !state.changedLibrary
    state.connected = false
    state.generation++
    cancelSearch()
    render()
    return modal(connectionView(state))
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
    const s = skillFor(state)
    return modal(
      `<h2 id="dialog-title">Review content · ${s.id}</h2><div class="target">${s.source || `Local · ${library}/skills/${s.id}`}<p>Reviewed snapshot: ${s.version}</p></div><h3>SKILL.md · sample instructions</h3><p>Read the proposed change and its tests. Verify rollback preserves existing data.</p><p>Full tree: SKILL.md only in this sample. Supporting files and executable modes must be reviewable before production acceptance.</p>${!s.accepted ? sampleDiff : ''}<div class="notice">Content review does not approve or expose this skill.</div><footer><button data-action="close">Close</button></footer>`,
    )
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
    exposuresFor(state)[state.selected].protected = {
      modified: 'Modified here',
      pinned: 'Pinned',
      unmanaged: 'Unmanaged target',
      blocked: 'Blocked source',
    }[name]
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
  if (name === 'stale') state.stale = true
}
$('#destination').innerHTML = destinations
  .map((d) => `<option value="${d.id}">${escapeHtml(d.label)}</option>`)
  .join('')
document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button || button.disabled) return
  if (button.dataset.action) return action(button.dataset.action)
  if (button.dataset.viewer) return selectViewer(button.dataset.viewer)
  if (button.dataset.select) {
    state.selected = button.dataset.select
    return render()
  }
  if (button.dataset.menu) {
    state.selected = button.dataset.menu
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
    state.enabled = event.target.checked
    state.connected = false
    state.generation++
    cancelSearch()
    render()
    modal(connectionView(state))
  }
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
      `Local source → ${d.label}${stub.disabled ? ' · Remote Stub unavailable' : ''}`
  }
})
document.addEventListener('input', (event) => {
  if (event.target.id === 'search') state.query = event.target.value
})
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !event.target.matches('input,select,textarea') &&
    !$('#dialog').open
  ) {
    event.preventDefault()
    selectViewer('skills')
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
$('#skills-nav').onclick = () => selectViewer('skills')
$('#close-skills').onclick = () => {
  state.skillsOpen = false
  selectViewer('document')
}
$('#library-nav').onclick = () => {
  cancelSearch()
  state.perspective = 'library'
  render()
}
$('#workspace-nav').onclick = () => {
  cancelSearch()
  state.perspective = 'workspace'
  render()
}
const periodic = setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    state.viewer === 'skills'
  )
    refresh()
}, 60_000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.hasFocus()) refresh()
})
window.addEventListener('focus', refresh)
window.addEventListener('pagehide', () => {
  cancelSearch()
  clearInterval(periodic)
  clearTimeout(toastTimer)
  state.connected = false
  state.generation++
})
render()
