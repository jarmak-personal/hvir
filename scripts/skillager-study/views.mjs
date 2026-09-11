import {
  library,
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
  return `<h2 id="dialog-title">Settings · Skillager</h2><p>Optional built-in integration</p>
    <label class="inline"><input type="checkbox" id="enabled" ${state.enabled ? 'checked' : ''}>Enable Skillager</label>
    ${
      state.enabled
        ? `<div class="target">Resolved executable<code>Local · /home/example/.local/bin/skillager · 0.9.0</code></div>
      <div class="target">Registered personal library<code>Local · ${library}${state.changedLibrary ? '-new' : ''}</code><small>Sample identity: library-7f29</small></div>
      <p>Connecting grants metadata access. Review content opens selected bodies or diffs. Accept library changes is a separate confirmation.</p>
      ${button('change-library', 'Change library (sample)')}
      ${button('connect', state.connected ? 'Connected' : 'Connect this library', state.missing || state.connected)}`
        : '<p>Enable the integration to choose its local installation and library.</p>'
    }
    <footer>${button('close', 'Close')}</footer>`
}
export function catalogView(state) {
  const heading = `<div class="heading"><div><h1>${state.perspective === 'library' ? 'Personal library' : 'Workspace skills'}</h1><p>Review instructions and choose when workspace copies change.</p></div>${button('refresh', '↻ Refresh', !state.connected)}</div>`
  if (!state.connected)
    return (
      heading +
      `<div class="empty"><h2>${state.missing ? 'Skillager unavailable' : 'Connect Skillager'}</h2><p>${state.missing ? 'The selected executable could not be found. Check Settings and retry.' : 'The integration starts disabled. Enable it in Settings, then connect the displayed personal library.'}</p>${button('settings', 'Open Skillager settings')}</div>`
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
      (state.perspective === 'library' || current[s.id]) &&
      (state.filter !== 'pending' || !s.accepted),
  )
  return (
    heading +
    `${remote ? `<div class="notice"><strong>Source:</strong> Local personal library → <strong>Destination:</strong> ${escapeHtml(destinationFor(state).label)}<p>Full skill files only · no remote Skillager. Remote management here is simulated; production awaits its portable package and compare/apply contracts.</p></div>` : ''}
    <form id="search-form" class="search-bar"><input id="search" aria-label="Search skill metadata and accepted body" placeholder="Search titles, descriptions, tags and accepted bodies…" maxlength="1000" value="${escapeHtml(state.query)}"><select id="search-scope" aria-label="Search scope"><option value="personal" ${state.scope === 'personal' ? 'selected' : ''}>Personal library</option><option value="available" ${state.scope === 'available' ? 'selected' : ''} ${remote ? 'disabled' : ''}>All available to this workspace</option></select><button class="primary" type="submit">Search</button>${button('cancel-search', 'Cancel search', !state.searching)}</form>
    <p class="search-caption">Enter/Search submits · up to 50 ranked metadata results · no total or pagination.<br>Accepted-body search covers the first 50,000 characters. Pending drafts remain browsable below.</p>
    <div id="search-status" role="status">${state.searching ? 'Searching Skillager… Initial indexing may take several seconds.' : state.results ? `${rows.length} results returned · ${state.scope === 'personal' ? 'Personal library · workspace exposure unknown in search' : 'All available to this workspace'}` : 'Metadata only. Use Review content to open a body or diff.'}</div>
    <div class="toolbar"><label>Browse <select id="filter"><option value="all">All metadata</option><option value="pending" ${state.filter === 'pending' ? 'selected' : ''}>Pending review</option></select></label><span id="freshness">${escapeHtml(state.lastChecked)}</span></div>
    <small>Refresh on visibility, after actions, and every 60 seconds while this tab is visible and the app is foregrounded. Only the active workspace is observed.</small>
    <div class="catalog-layout"><section id="skill-list">${rows.map((s) => `<div class="skill-row ${s.id === state.selected ? 'selected' : ''}" data-skill="${s.id}"><button data-select="${s.id}"><h3>${s.id}</h3><p>${s.description}</p><small>${s.source || 'Owned · Personal library'} · ${state.perspective === 'library' ? (s.accepted ? 'Accepted' : 'Needs review') : `${modeLabel(current[s.id].mode)} · ${statusFor(s, current[s.id])}`}${state.results ? ` · ${s.match} match` : ''}</small></button><button class="more" data-menu="${s.id}" aria-label="Actions for ${s.id}">⋯</button></div>`).join('') || '<p class="empty">No matching skills</p>'}</section><aside class="details" id="details">${detailView(state)}</aside></div>`
  )
}
export function detailView(state) {
  const s = skillFor(state),
    e = exposuresFor(state)[s.id]
  const blocked = !!e?.protected || !s.accepted || !!s.source
  return `<h2>${s.id}</h2><p>${s.description}</p><dl><dt>Source</dt><dd>${s.source || 'Local personal library'}</dd><dt>Library review</dt><dd>${s.accepted ? 'Accepted' : 'Needs review'}</dd><dt>Accepted version</dt><dd>${s.accepted ? s.version : s.acceptedVersion}</dd></dl>
    <hr><h3>${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}</h3><p class="pill">${statusFor(s, e)}</p>${e ? `<dl><dt>Exposure</dt><dd>${modeLabel(e.mode)}</dd><dt>Exposed version</dt><dd>${e.version}</dd></dl>` : ''}
    ${s.source ? '<div class="notice">External ownership is preserved. Search does not import this skill.</div>' : ''}
    ${button('read', 'Review content…')}${button('history', 'Version history')}
    ${!s.accepted ? button('accept', 'Review library changes…') : ''}
    ${button('add', 'Add to project…', blocked || !!e)}
    ${e ? button('switch', 'Change exposure mode…', blocked || destinationFor(state).host !== 'local') + button('update', 'Review workspace update…', blocked || e.version === s.version) + button('remove', 'Remove from workspace…', !!e.protected) : ''}`
}
export function pickerView(state) {
  return `<h2 id="dialog-title">Add ${state.selected}</h2><p>Choose an exact registered project/worktree and agent.</p>
    <label>Destination<select id="add-destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === state.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label>
    <label>Agent<select id="add-agent"><option value="codex" ${state.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${state.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label>
    <label>Exposure mode<select id="add-mode"><option value="native">Full skill</option><option value="stub" ${destinationFor(state).host !== 'local' ? 'disabled' : ''}>Stub</option></select></label>
    <p>Full skill copies the reviewed files. A Stub is a small activation handle requiring Skillager on the agent’s host.</p><div id="add-route" class="target">Local source → ${escapeHtml(destinationFor(state).label)}</div>
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
  const protectedTarget = !accepting && (e?.protected || (preview.action === 'add' && e))
  const target = targetPath(state, s)
  return `<h2 id="dialog-title">${label} · ${s.id}</h2><p>Review the exact version and every sample file effect before confirming.</p>
    <div class="target">Source<code>Local · ${library}/skills/${s.id}</code><p>Version ${s.version}</p></div>
    ${accepting ? `<div class="notice">This accepts the exact reviewed library version. Workspace copies stay unchanged.</div>${sampleDiff}<p>Scan: low · Lint: passed · No override requested</p>` : `<div class="target">Destination: ${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}<code>${target}</code><p>${modeLabel(preview.mode)} · existing ${e?.version || 'absent'}</p></div>`}
    ${!accepting && ['update', 'switch'].includes(preview.action) ? sampleDiff : ''}
    <h3>All file effects · sample manifest</h3><ul>${accepting ? `<li>Record exact library approval and content history.</li><li>No workspace file writes.</li>` : removing ? `<li>Remove ${target}/SKILL.md and the managed exposure receipt.</li><li>No library or other workspace writes.</li>` : `<li>${e ? 'Replace unchanged managed' : 'Create'} ${target}/SKILL.md</li><li>${e ? 'Replace' : 'Create'} ${target}/skillager.materialized.yaml</li><li>Supporting instructions: none in this sample package.</li>`}</ul>
    ${destinationFor(state).host !== 'local' && !accepting ? '<div class="notice">Stage and verify every Full skill file, then compare and publish the exact managed target. Remote Stub, Working skill, router and remote executable are absent. Runtime dependencies: none in this sample.</div>' : ''}
    ${protectedTarget ? `<div class="notice">${typeof protectedTarget === 'string' ? protectedTarget : 'Already added'}: preserve this target. Ordinary replacement and removal are unavailable.</div>` : ''}
    <small>The study simulates the accepted contract. Production actions require actual CLI-bound preview/apply and complete effects.</small>
    <footer>${button('close', 'Cancel')}${button('apply', label, !!protectedTarget)}</footer>`
}
