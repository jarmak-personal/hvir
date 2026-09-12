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
  `<button type="button" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`
function missingCliView() {
  return `<div class="notice"><h2>Skillager wasn’t found.</h2><p>Install Skillager in your local terminal:</p><code>uv tool install skillager</code><p>Then choose Check again.</p>${button('check-again', 'Check again')}</div>`
}
function executableDetails() {
  return '<details class="connection-details"><summary>Connection details</summary><p>Resolved executable</p><code>Local · /home/example/.local/bin/skillager · 0.9.1</code></details>'
}
function registeredLibraryView(state) {
  return `<div class="target">Personal library<code>Local · ${escapeHtml(state.library.path)}</code><small>Git history: ${state.library.git ? 'enabled' : 'disabled'}</small></div>
    ${state.setup.message ? `<p role="status">${escapeHtml(state.setup.message)}</p>` : ''}
    <p>Connect to browse metadata. Content review and acceptance remain separate actions.</p>
    ${button('connect', state.connected ? 'Connected' : 'Connect this library', state.connected)}`
}
export function connectionView(state) {
  return `<h2 id="dialog-title">Settings</h2>
    <label class="inline"><input type="checkbox" id="enabled" ${state.enabled ? 'checked' : ''}>Enable Skillager</label>
    ${
      state.enabled
        ? state.missing
          ? missingCliView()
          : `
      ${state.libraryMissing ? `<h3>Set up your personal library</h3><p>Create a local home for reusable skills.</p>${button('show-setup', 'Set up library')}` : registeredLibraryView(state) + button('change-library', 'Change library (sample)')}
      ${executableDetails()}`
        : ''
    }
    <footer>${button('close', 'Close')}</footer>`
}
function setupView(state) {
  const setup = state.setup
  const status = setup.message ? `<p role="status">${escapeHtml(setup.message)}</p>` : ''
  if (setup.status === 'creating')
    return `<section class="library-setup"><h2>Creating your personal library…</h2><p role="status">Initializing and checking Local · ${escapeHtml(setup.path)}</p><p>Git history: ${setup.git ? 'enabled' : 'disabled'}</p>${button('cancel-setup', 'Cancel setup')}</section>`
  if (setup.status === 'uncertain')
    return `<section class="library-setup"><h2>Check your library setup</h2>${status}${button('check-setup', 'Check library status')}</section>`
  return `<form id="library-setup" class="library-setup"><h2>Set up your personal library</h2><p>A local home for skills you reuse across projects.</p>
    <label>Library location · Local<input id="library-location" value="${escapeHtml(setup.path)}" readonly></label>
    <small>Default: ~/.skillager/library on this computer.</small>${button('choose-folder', 'Choose folder…')}
    <label class="inline"><input id="library-git" type="checkbox" ${setup.git ? 'checked' : ''}>Keep Git history</label>
    <p>Version history for this personal library. Project Git and ignore files stay as you choose.</p>
    ${status}<button class="primary" type="submit">Create and connect</button>
    <small>Creates and registers this library, then connects for metadata browsing.</small>
  </form>`
}
function firstSkillView(state) {
  const prompt = `Help me create my first reusable skill in my local Skillager library at ${JSON.stringify(state.library.path)}. Ask what workflow I repeat, then use Skillager's public authoring workflow to create a draft. Leave it pending for me to review and accept in hvir. Do not expose it to a project or change project Git or ignore files.`
  return `<section class="first-skill"><h2>Create your first skill</h2>${state.setup.message ? `<p role="status">${escapeHtml(state.setup.message)}</p>` : ''}<p>Personal-library Git history: ${state.library.git ? 'enabled' : 'disabled'}</p><p>Give this prompt to your agent in a local terminal:</p><textarea id="first-skill-prompt" aria-label="First skill agent prompt" readonly rows="8">${escapeHtml(prompt)}</textarea><p>Return here and refresh, then review and accept the draft before adding it to a workspace.</p>${button('refresh', 'Refresh library')}</section>`
}
export function catalogView(state) {
  if (!state.enabled) return ''
  if (state.missing) return missingCliView()
  if (state.libraryMissing) return setupView(state) + executableDetails()
  const heading = `<div class="heading"><div><h1>${state.perspective === 'library' ? 'Personal library' : 'Workspace skills'}</h1><p>Review instructions and choose when workspace copies change.</p></div>${button('refresh', '↻ Refresh', !state.connected)}</div>`
  if (!state.connected)
    return (
      heading +
      `<div class="empty"><h2>Connect Skillager</h2>${registeredLibraryView(state)}${executableDetails()}</div>`
    )
  if (state.empty && state.results === null && !state.submittedQuery)
    return (
      heading +
      (state.perspective === 'library'
        ? firstSkillView(state)
        : '<p class="empty">No skills added to this workspace.</p>')
    )
  const remote = destinationFor(state).host !== 'local'
  const current = exposuresFor(state)
  const rows = (state.results || state.skills).filter(
    (s) =>
      (state.perspective === 'library' || current[s.id] || unmanagedFor(state, s.id)) &&
      (state.filter !== 'pending' || !s.accepted),
  )
  return `${remote ? `<details class="search-caption"><summary>Local library → ${escapeHtml(destinationFor(state).label)}</summary><p>hvir manages this SSH workspace with the same Add, Update, and Remove actions. Full skill files only; no Skillager installation is needed on this host.</p></details>` : ''}
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
    ${unmanaged ? `<p>No recorded ${destinationFor(state).host === 'local' ? 'Skillager exposure' : 'hvir deployment'} mode or version. Existing files are preserved.</p>` : ''}
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
  const remote = destinationFor(state).host !== 'local'
  const recordEffect = remote
    ? `${removing ? 'Remove' : e ? 'Update' : 'Create'} hvir’s deployment record for this workspace and agent.`
    : `${removing ? 'Remove' : e ? 'Replace' : 'Create'} ${target}/skillager.materialized.yaml`
  return `<h2 id="dialog-title">${label} · ${s.id}</h2><p>Review the exact version and every sample file effect before confirming.</p>
    <div class="target">Source<code>Local · ${state.library.path}/skills/${s.id}</code><p>Version ${s.version}</p></div>
    ${accepting ? `<div class="notice">This accepts the exact reviewed library version. Workspace copies stay unchanged.</div>${sampleDiff}<p>Scan: low · Lint: passed · No override requested</p>` : `<div class="target">Destination: ${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}<code>${target}</code><p>${modeLabel(preview.mode)} · existing ${e?.version || 'absent'}</p></div>`}
    ${!accepting && ['update', 'switch'].includes(preview.action) ? sampleDiff : ''}
    <h3>Changes in this preview</h3><ul>${accepting ? `<li>Record exact library approval and content history.</li><li>No workspace file writes.</li>` : removing ? `<li>Remove ${target}/SKILL.md</li><li>${recordEffect}</li><li>No library or other workspace writes.</li>` : `<li>${e ? 'Replace unchanged managed' : 'Create'} ${target}/SKILL.md</li><li>${recordEffect}</li><li>Supporting instructions: none in this sample package.</li>`}</ul>
    ${remote && !accepting ? '<div class="notice">hvir checks this workspace before applying changes and preserves files changed here. Full skill only; no remote Skillager installation. Runtime requirements: none in this sample.</div>' : ''}
    ${protectedTarget ? `<div class="notice">${typeof protectedTarget === 'string' ? protectedTarget : 'Already added'}: preserve this target. Ordinary replacement and removal are unavailable.</div>` : ''}
    <small>Sample preview · no real files will change in this study.</small>
    <footer>${button('close', 'Cancel')}${button('apply', label, !!protectedTarget)}</footer>`
}

export function skillsRailView(state) {
  if (!state.enabled) return ''
  const pending = state.skills.filter((s) => !s.accepted).length
  const updates = state.skills.filter(
    (s) => statusFor(s, exposuresFor(state)[s.id]) === 'Workspace copy behind',
  ).length
  return `<div class="skills-scope"><button id="library-nav" data-perspective="library">Personal library</button><button id="workspace-nav" data-perspective="workspace">This workspace</button></div>
    ${state.connected && !state.empty ? `<div class="feature-badges"><span id="review-count">${pending} library review${pending === 1 ? '' : 's'}</span><span id="updates-count">${updates} workspace update${updates === 1 ? '' : 's'}</span></div>` : ''}
    ${state.connected ? `<div class="rail-controls"><label>Destination<select id="destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === state.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label><label>Agent<select id="agent"><option value="codex" ${state.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${state.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label></div>` : ''}
    <div id="content">${catalogView(state)}<p id="connection-label">${state.connected ? 'Local Skillager connected' : 'Skillager disconnected'}</p></div>`
}
export function reviewView(state) {
  const s = skillFor(state)
  return `<h2>Review content · ${s.id}</h2><div class="target">${s.source || `Local · ${state.library.path}/skills/${s.id}`}<p>Reviewed snapshot: ${s.version}</p></div><h3>SKILL.md · sample instructions</h3><p>Read the proposed change and its tests. Verify rollback preserves existing data.</p><p>Full tree: SKILL.md only in this sample. Supporting files and executable modes must be reviewable before production acceptance.</p>${!s.accepted ? sampleDiff : ''}<div class="notice">Content review does not approve or expose this skill.</div>${button('metadata', 'Back to metadata')}`
}
