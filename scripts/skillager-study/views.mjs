import {
  unmanagedFor,
  destinations,
  destinationFor,
  exposuresFor,
  skillFor,
  statusFor,
  modeLabel,
  agentLabel,
  targetPath,
} from './model.mjs'
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const button = (action, label, disabled = false) =>
  `<button data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`
export function connectionView(state) {
  return `<h2 id="dialog-title">Settings</h2>
    <label class="inline"><input type="checkbox" id="enabled" ${state.enabled ? 'checked' : ''}>Enable Skillager</label>
    ${
      state.enabled
        ? `<div class="target">Resolved executable<code>Local · /home/example/.local/bin/skillager · 0.9.0</code></div>
      <div class="target">Registered personal library<code>Local · ${state.library.path}</code><small>Sample identity: ${state.library.id}</small></div>
      <p>Connecting grants metadata access. Review content opens selected bodies or diffs. Accept library changes is a separate confirmation.</p>
      ${button('change-library', 'Change library (sample)')}
      ${button('connect', state.connected ? 'Connected' : 'Connect this library', state.missing || state.connected)}`
        : ''
    }
    <footer>${button('close', 'Close')}</footer>`
}
export function catalogView(state) {
  if (!state.enabled) return ''
  const heading = `<div class="heading"><div><h1>${state.perspective === 'library' ? 'Personal library' : 'Workspace skills'}</h1><p>Review instructions and choose when workspace copies change.</p></div>${button('refresh', '↻ Refresh', !state.connected)}</div>`
  if (!state.connected)
    return (
      heading +
      `<div class="empty"><h2>${state.missing ? 'Skillager unavailable' : 'Connect Skillager'}</h2><p>${state.missing ? 'The selected executable could not be found. Check Settings and retry.' : 'Connect the displayed personal library in Settings to browse metadata. Enabling alone grants no access.'}</p>${button('settings', 'Open Skillager settings')}</div>`
    )
  if (state.empty)
    return (
      heading +
      '<div class="empty"><h2>Your library starts with one useful skill</h2><p>Create or import a skill through Skillager, then refresh.</p></div>'
    )
  const remote = destinationFor(state).host !== 'local'
  const current = exposuresFor(state)
  const rows = (state.results || state.skills).filter(
    (s) =>
      (state.perspective === 'library' || current[s.id] || unmanagedFor(state, s.id)) &&
      (state.filter !== 'pending' || !s.accepted),
  )
  return `${remote ? `<details class="search-caption"><summary>Local library → ${escapeHtml(destinationFor(state).label)}</summary><p>Full skill files only · no remote Skillager. Remote management here is simulated; production awaits its portable package and compare/apply contracts.</p></details>` : ''}
    <form id="search-form" class="search-bar"><input id="search" aria-label="Search skill metadata and accepted body" placeholder="Search titles, descriptions, tags and accepted bodies…" maxlength="1000" value="${escapeHtml(state.query)}"><select id="search-scope" aria-label="Search scope"><option value="personal" ${state.scope === 'personal' ? 'selected' : ''}>Personal library</option><option value="available" ${state.scope === 'available' ? 'selected' : ''} ${remote ? 'disabled' : ''}>All available to this workspace</option></select><button class="primary" type="submit">Search</button>${button('cancel-search', 'Cancel search', !state.searching)}</form>
    <details class="search-caption"><summary>Search coverage · first 50,000 body characters</summary><p>Enter/Search submits up to 50 ranked metadata results. No total or pagination. Only accepted bodies are searched; pending drafts remain in metadata browsing. Refresh runs every 60 seconds while this sidebar or a skill viewer is visible and the app is foregrounded, for the active workspace only.</p></details>
    <div id="search-status" role="status">${state.searching ? `Searching Skillager for “${escapeHtml(state.submittedQuery)}”… Initial indexing may take several seconds.` : state.results ? `${rows.length} results returned for “${escapeHtml(state.submittedQuery)}” · ${state.scope === 'personal' ? 'Personal library · workspace exposure unknown in search' : 'All available to this workspace'}` : 'Metadata only · Review content opens bodies/diffs.'}</div>
    <div class="toolbar"><label>Browse <select id="filter"><option value="all">All metadata</option><option value="pending" ${state.filter === 'pending' ? 'selected' : ''}>Pending review</option></select></label>${button('refresh', '↻ Refresh')}</div><p id="freshness" class="muted">${escapeHtml(state.lastChecked)}</p>
    <section id="skill-list">${rows.map((s) => `<div class="skill-row ${s.id === state.selected ? 'selected' : ''}" data-skill="${s.id}"><button data-select="${s.id}"><h3>${s.id}</h3><p>${s.description}</p><small>${s.source || 'Owned · Personal library'} · ${state.perspective === 'library' ? (s.blocked ? 'Blocked source' : s.accepted ? 'Accepted' : 'Needs review') : unmanagedFor(state, s.id) ? 'Unmanaged target' : `${modeLabel(current[s.id].mode)} · ${statusFor(s, current[s.id])}`}${state.results ? ` · ${s.match} match` : ''}</small></button><button class="more" data-menu="${s.id}" aria-label="Actions for ${s.id}">⋯</button></div>`).join('') || '<p class="empty">No matching skills</p>'}</section>`
}
export function detailView(state) {
  const s = skillFor(state),
    e = exposuresFor(state)[s.id]
  const unmanaged = unmanagedFor(state, s.id)
  const blocked = !!e?.protected || unmanaged || !!s.blocked || !s.accepted || !!s.source
  return `<h2>${s.id}</h2><p>${s.description}</p><dl><dt>Source</dt><dd>${s.source || 'Local personal library'}</dd><dt>Library review</dt><dd>${s.accepted ? 'Accepted' : 'Needs review'}</dd><dt>Source status</dt><dd>${s.blocked ? 'Blocked by library policy' : 'Available for review'}</dd><dt>Accepted version</dt><dd>${s.accepted ? s.version : s.acceptedVersion}</dd></dl>
    <hr><h3>${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}</h3><p class="pill">${unmanaged ? 'Unmanaged target' : statusFor(s, e)}</p>${e ? `<dl><dt>Exposure</dt><dd>${modeLabel(e.mode)}</dd><dt>Exposed version</dt><dd>${e.version}</dd></dl>` : ''}
    ${unmanaged ? '<p>No recorded Skillager exposure mode or version. Existing files are preserved.</p>' : ''}
    ${s.source ? '<div class="notice">External ownership is preserved. Search does not import this skill.</div>' : ''}
    ${button('read', 'Review content…')}${button('history', 'Version history')}
    ${!s.accepted ? button('accept', 'Review library changes…', !!s.blocked) : ''}
    ${button('add', 'Add to project…', blocked || !!e)}
    ${e || unmanaged ? button('switch', 'Change exposure mode…', blocked || destinationFor(state).host !== 'local') + button('update', 'Review workspace update…', blocked || e?.version === s.version) + button('remove', 'Remove from workspace…', !!e?.protected || unmanaged || !!s.blocked) : ''}`
}
export function pickerView(state) {
  return `<h2 id="dialog-title">Add ${state.selected}</h2><p>Choose an exact registered project/worktree and agent.</p>
    <label>Destination<select id="add-destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === state.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label>
    <label>Agent<select id="add-agent"><option value="codex" ${state.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${state.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label>
    <label>Exposure mode<select id="add-mode"><option value="native">Full skill</option><option value="stub" ${destinationFor(state).host !== 'local' ? 'disabled' : ''}>Stub</option></select></label>
    <p>Full skill copies the reviewed files. A Stub is a small activation handle requiring Skillager on the agent’s host.</p><div id="add-route" class="target">Local · ${state.library.path} → ${escapeHtml(destinationFor(state).label)}</div>
    <footer>${button('close', 'Cancel')}${button('preview-add', 'Preview addition')}</footer>`
}
export const sampleDiff = `<pre class="diff">  ## Review steps\n<span class="del">− Check the rollback plan.</span><span class="add">+ Verify rollback preserves existing data.</span><span class="add">+ Call out blocking operations before approval.</span></pre>`
export function previewView(state, preview) {
  const s = skillFor(state),
    e = exposuresFor(state)[s.id]
  const accepting = preview.action === 'accept',
    removing = preview.action === 'remove'
  const label = accepting
    ? 'Accept library changes'
    : removing
      ? 'Remove from workspace'
      : preview.action === 'switch'
        ? `Change to ${modeLabel(preview.mode)}`
        : preview.action === 'update'
          ? 'Update this workspace'
          : 'Add to workspace'
  const protectedTarget =
    s.blocked ||
    (!accepting &&
      (unmanagedFor(state, s.id) || e?.protected || (preview.action === 'add' && e)))
  const target = targetPath(state, s)
  return `<h2 id="dialog-title">${label} · ${s.id}</h2><p>Review the exact version and every sample file effect before confirming.</p>
    <div class="target">Source<code>Local · ${state.library.path}/skills/${s.id}</code><p>Version ${s.version}</p></div>
    ${accepting ? `<div class="notice">This accepts the exact reviewed library version. Workspace copies stay unchanged.</div>${sampleDiff}<p>Scan: low · Lint: passed · No override requested</p>` : `<div class="target">Destination: ${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}<code>${target}</code><p>${modeLabel(preview.mode)} · existing ${e?.version || 'absent'}</p></div>`}
    ${!accepting && ['update', 'switch'].includes(preview.action) ? sampleDiff : ''}
    <h3>All file effects · sample manifest</h3><ul>${accepting ? `<li>Record exact library approval and content history.</li><li>No workspace file writes.</li>` : removing ? `<li>Remove ${target}/SKILL.md and the managed exposure receipt.</li><li>No library or other workspace writes.</li>` : `<li>${e ? 'Replace unchanged managed' : 'Create'} ${target}/SKILL.md</li><li>${e ? 'Replace' : 'Create'} ${target}/skillager.materialized.yaml</li><li>Supporting instructions: none in this sample package.</li>`}</ul>
    ${destinationFor(state).host !== 'local' && !accepting ? '<div class="notice">Stage and verify every Full skill file, then compare and publish the exact managed target. Remote Stub, Working skill, router and remote executable are absent. Runtime dependencies: none in this sample.</div>' : ''}
    ${protectedTarget ? `<div class="notice">${typeof protectedTarget === 'string' ? protectedTarget : 'Already added'}: preserve this target. Ordinary replacement and removal are unavailable.</div>` : ''}
    <small>The study simulates the accepted contract. Production actions require actual CLI-bound preview/apply and complete effects.</small>
    <footer>${button('close', 'Cancel')}${button('apply', label, !!protectedTarget)}</footer>`
}

export function skillsRailView(state) {
  if (!state.enabled) return ''
  const pending = state.skills.filter((s) => !s.accepted).length
  const updates = state.skills.filter(
    (s) => statusFor(s, exposuresFor(state)[s.id]) === 'Workspace copy behind',
  ).length
  return `<div class="skills-scope"><button id="library-nav" data-perspective="library">Personal library</button><button id="workspace-nav" data-perspective="workspace">This workspace</button></div>
    ${state.connected ? `<div class="feature-badges"><span id="review-count">${pending} library review${pending === 1 ? '' : 's'}</span><span id="updates-count">${updates} workspace update${updates === 1 ? '' : 's'}</span></div>` : ''}
    <div class="rail-controls"><label>Destination<select id="destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === state.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label><label>Agent<select id="agent"><option value="codex" ${state.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${state.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label></div>
    <div id="content">${catalogView(state)}<p id="connection-label">${state.connected ? 'Local Skillager connected' : 'Skillager disconnected'}</p></div>`
}
export function reviewView(state) {
  const s = skillFor(state)
  return `<h2>Review content · ${s.id}</h2><div class="target">${s.source || `Local · ${state.library.path}/skills/${s.id}`}<p>Reviewed snapshot: ${s.version}</p></div><h3>SKILL.md · sample instructions</h3><p>Read the proposed change and its tests. Verify rollback preserves existing data.</p><p>Full tree: SKILL.md only in this sample. Supporting files and executable modes must be reviewable before production acceptance.</p>${!s.accepted ? sampleDiff : ''}<div class="notice">Content review does not approve or expose this skill.</div>${button('metadata', 'Back to metadata')}`
}
