// Closed sample documents only. No filesystem, CLI, approval or snapshot authority.
import { destinationFor, skillFor, exposuresFor, projectSampleFor } from './model.mjs'
import { curationSource, curationRouter, curationTarget } from './curation-model.mjs'
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
export function selectedDocument(state) {
  const destination = destinationFor(state)
  const library = (id, name, version, status) => ({
    id,
    name,
    version,
    status,
    label: 'Your library',
    host: 'local',
    path: `${state.library.path}/skills/${id}/SKILL.md`,
    library: state.library.id,
  })
  const project = (row, mode, version, status, path) => ({
    id: row.id,
    name: row.name || row.id,
    version,
    status,
    host: destination.host,
    label: mode === 'Original' ? 'Project original' : `Installed ${mode}`,
    path: `${path}/SKILL.md`,
    agent: row.projectAgent ?? row.agent,
  })
  if (state.curation) {
    const router = curationRouter(state)
    if (state.curation.selectedRouter)
      return project(
        router,
        'Router',
        String(router.version),
        'Managed router',
        curationTarget(state, router),
      )
    const row = curationSource(state)
    if (state.curation.selectedScope === 'library')
      return library(
        `synced-${row.id}`,
        row.name,
        row.libraryVersion,
        row.libraryAccepted &&
          !row.libraryBlocked &&
          row.libraryVersion === row.libraryAcceptedVersion
          ? 'Accepted current file'
          : 'Pending current file',
      )
    if (row.mode === 'Router member') {
      const memberships = state.curation.routers.filter((group) =>
        group.members.includes(row.id),
      )
      const selected = state.curation.selectedMemberRouter
        ? memberships.find((group) => group.id === state.curation.selectedMemberRouter)
        : memberships.length === 1
          ? memberships[0]
          : null
      if (!selected)
        return {
          id: row.id,
          name: row.name,
          unavailable: 'Select the concrete installed router to read this membership.',
        }
      return {
        ...project(
          selected,
          'Router',
          String(selected.version),
          'Managed router',
          curationTarget(state, selected),
        ),
        member: row.name,
      }
    }
    if (!row.projectPresent || !(row.projectAgent ?? row.agent))
      return {
        id: row.id,
        name: row.name,
        unavailable:
          'This external source has no confined project or library document grant.',
      }
    return project(
      row,
      row.managed ? (row.mode === 'Stub' ? 'Stub' : 'Full') : 'Original',
      row.managed ? row.exposedVersion : row.version,
      row.managed
        ? row.targetProtected
          ? 'Modified current file'
          : 'Installed version; current file'
        : row.originBlocked
          ? 'Blocked current file'
          : row.approved && row.version === row.approvedVersion
            ? 'Approved current file'
            : 'Pending current file',
      curationTarget(state, row),
    )
  }
  if (state.nativeSelected) {
    const row = projectSampleFor(state)?.rows.find((r) => r.id === state.nativeSelected)
    if (!row) return { unavailable: 'This project occurrence is no longer available.' }
    return project(
      row,
      'Original',
      'current-project-file',
      row.review,
      `${destination.path}/${row.agent === 'claude' ? '.claude' : '.agents'}/skills/${row.id}`,
    )
  }
  const row = skillFor(state),
    exposure = exposuresFor(state)[row.id]
  if (row.source)
    return {
      id: row.id,
      name: row.id,
      unavailable:
        'This external source has no confined project or library document grant.',
    }
  if (state.selectedScope === 'workspace' && exposure)
    return project(
      { ...row, agent: state.agent },
      exposure.mode === 'stub' ? 'Stub' : 'Full',
      exposure.version,
      exposure.protected || 'Installed version; current file',
      `${destination.path}/${state.agent === 'claude' ? '.claude' : '.agents'}/skills/lib-${row.id}`,
    )
  return library(
    row.id,
    row.id,
    row.version,
    row.blocked
      ? 'Blocked current file'
      : row.accepted
        ? 'Accepted current file'
        : 'Pending current file',
  )
}
const binding = (state) =>
  JSON.stringify([
    state.generation,
    state.destination,
    state.library.id,
    selectedDocument(state),
  ])
export function createSampleReader(current, render) {
  let timer,
    generation = 0
  function revoke() {
    generation++
    globalThis.clearTimeout(timer)
    current().reading = null
  }
  function activate() {
    revoke()
    const state = current()
    if (!state.enabled || !state.connected || state.viewer !== 'skills') return
    const source = selectedDocument(state),
      expected = binding(state),
      request = generation
    if (source.unavailable) {
      state.reading = { source, error: source.unavailable }
      return
    }
    if (state.selectedSearchVersion && state.selectedSearchVersion !== source.version) {
      state.reading = {
        source,
        error:
          'This source changed since the search observation. Select its current file from browsing; this is not the accepted search version.',
      }
      return
    }
    state.readCount = (state.readCount || 0) + 1
    state.reading = { source, pending: true }
    timer = globalThis.setTimeout(() => {
      if (
        request !== generation ||
        !state.enabled ||
        !state.connected ||
        state.viewer !== 'skills' ||
        expected !== binding(current())
      )
        return
      const instructions =
        source.label === 'Installed Stub'
          ? 'This installed stub asks the agent to activate the skill with Skillager. It is not the library definition.'
          : source.label === 'Installed Router'
            ? 'This installed router selects instructions from its named members. It is not a member’s canonical definition.'
            : 'Read the change and its tests. Explain the constraints before proposing the next step.'
      state.reading = {
        source,
        body: `# ${source.name}\n\n${instructions}\n\nSelected current version: ${source.version}.\n\nSample instructions only.`,
      }
      render()
    }, state.sampleReadDelay ?? 25)
  }
  return { activate, revoke }
}
export function readingView(state) {
  const read = state.reading
  if (!read)
    return '<p class="reading-empty">Activate a skill row or its tab to read that current file.</p>'
  const source = read.source
  if (read.error)
    return `<section class="skill-reading"><h2>${escape(source.name || 'Selected skill')}</h2><p role="status">${escape(read.error)}</p></section>`
  const changed = JSON.stringify(source) !== JSON.stringify(selectedDocument(state))
  return `<section class="skill-reading" aria-label="Selected skill current file"><header><h2>${escape(source.name)}</h2><p>${source.label} · Current file${source.member ? ` · selected member ${escape(source.member)}` : ''}</p><small>${escape(source.host)} · ${escape(source.path)}</small></header><p class="reading-status">${changed ? 'Source changed since this read. Activate again to read the current file.' : escape(source.status)} · ${escape(source.version)}</p>${read.pending ? `<p role="status">${changed ? 'The selected read is stale; activate the current source again.' : 'Reading selected file…'}</p>` : `<pre id="skill-current-body">${escape(read.body)}</pre>`}<small>Ordinary current-file view · no approval or verified tree snapshot.</small></section>`
}
