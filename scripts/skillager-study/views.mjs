import { addChoice, currentDirectAdd } from './direct-add.mjs'
import { directAddResultView } from './direct-add-view.mjs'
import { instructionIcon, copyGlyphs } from './skill-icons.mjs'
import { escapeHtml } from './html.mjs'
import { searchView, searchStatusView, matchedSourceView } from './search-views.mjs'
import { browseSampleRows } from './model.mjs'
import { curationCatalogView } from './curation-views.mjs'
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
  projectSampleFor,
  exposureKey,
} from './model.mjs'
export { escapeHtml } from './html.mjs'
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
    <div class="settings-field"><span>Skillager</span><label class="inline"><input type="checkbox" id="enabled" ${state.enabled ? 'checked' : ''}>Enable Skillager</label></div>
    ${
      state.enabled
        ? state.missing
          ? missingCliView()
          : `
      ${state.libraryMissing ? `<h3>Set up your personal library</h3><p>Create a local home for reusable skills.</p>${button('show-setup', 'Set up library')}` : state.connected ? `<p class="settings-connection">Connected to your library</p><details><summary>Library connection</summary>${registeredLibraryView(state)}${button('change-library', 'Change library (sample)')}</details>` : registeredLibraryView(state) + button('change-library', 'Change library (sample)')}
      ${executableDetails()}`
        : ''
    }
    <footer>${button('close', 'Save app settings')}</footer>`
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
  return `<section class="first-skill"><h2>Create your first skill</h2>${state.setup.message ? `<p role="status">${escapeHtml(state.setup.message)}</p>` : ''}<p>Personal-library Git history: ${state.library.git ? 'enabled' : 'disabled'}</p><p>Give this prompt to your agent in a local terminal:</p><textarea id="first-skill-prompt" aria-label="First skill agent prompt" readonly rows="8">${escapeHtml(prompt)}</textarea><p>Return here and refresh, then review and accept the draft before adding it to a workspace.</p>${button('refresh', 'Refresh library')}<p>Already approved skills elsewhere?</p>${button('sync-approved', 'Sync approved skills…')}</section>`
}
export function catalogView(state) {
  if (!state.enabled) return ''
  if (state.missing) return missingCliView()
  if (state.libraryMissing) return setupView(state) + executableDetails()
  if (state.initialLoading)
    return '<p class="initial-observation" role="status">Loading initial skill metadata…</p>'
  if (state.curation && state.connected) return curationCatalogView(state)
  if (
    state.projectStudy &&
    state.perspective === 'workspace' &&
    state.connected &&
    !state.results &&
    !state.searching
  )
    return projectWorkspaceView(state)
  const heading = `<div class="heading"><div><h1>${state.perspective === 'library' ? 'Personal library' : 'Workspace skills'}</h1><p>Review instructions and choose when workspace copies change.</p></div>${button('refresh', '↻ Refresh', !state.connected)}</div>`
  if (!state.connected)
    return (
      heading +
      `<div class="empty"><h2>Connect Skillager</h2>${registeredLibraryView(state)}${executableDetails()}</div>`
    )
  if (state.empty && state.results === null && !state.submittedQuery)
    return state.perspective === 'library'
      ? firstSkillView(state)
      : '<p class="empty">No skills added to this workspace.</p>'
  const remote = destinationFor(state).host !== 'local'
  const rows = browseSampleRows(state)
  return `${remote ? `<details class="search-caption"><summary>Local library → ${escapeHtml(destinationFor(state).label)}</summary><p>hvir manages this SSH workspace with the same Add, Update, and Remove actions. Full skill files only; no Skillager installation is needed on this host.</p></details>` : ''}
    ${searchStatusView(state)}
    <section class="${state.results || state.perspective === 'library' ? 'skill-list' : 'project-managed-list'}" aria-label="Skill list">${rows.map((s) => `<div class="skill-row ${s.id === state.selected && state.selectedScope === (s.resultScope || state.perspective) && (!s.rowAgent || s.rowAgent === state.agent) ? 'selected' : ''}" data-skill="${s.id}" data-row-scope="${s.resultScope || state.perspective}"><button data-select="${s.id}" ${state.results ? `data-occurrence="${s.occurrenceId}"` : ''} ${s.rowAgent ? `data-row-agent="${s.rowAgent}"` : ''}><span class="skill-name">${instructionIcon}${s.id}</span><small class="row-badges">${s.source ? `${s.source} · ` : ''}${state.results || state.perspective === 'library' ? (s.blocked ? 'Blocked source' : s.accepted ? 'Accepted' : 'Needs review') : s.rowUnmanaged ? 'Unmanaged target' : `${copyGlyphs(s.rowAgent, modeLabel(s.rowExposure?.mode))} ${statusFor(s, s.rowExposure) === 'Current' ? '' : statusFor(s, s.rowExposure)}`}${state.results ? ` · ${s.match} match` : ''}</small>${state.results ? matchedSourceView(s) : ''}</button><button class="more" data-menu="${s.id}" ${state.results ? `data-occurrence="${s.occurrenceId}"` : ''} ${s.rowAgent ? `data-row-agent="${s.rowAgent}"` : ''} aria-label="Actions for ${s.id}">⋯</button></div>`).join('') || (state.searching || state.searchReport?.unavailable ? '' : '<p class="empty">No matching skills</p>')}</section>`
}
export function detailView(state, menu = false) {
  const s = skillFor(state),
    e = exposuresFor(state)[s.id],
    unmanaged = unmanagedFor(state, s.id)
  const blocked = !!e?.protected || unmanaged || !!s.blocked || !s.accepted || !!s.source
  return `<h2>${instructionIcon}${s.id}</h2><p>${s.description}</p><div class="lifecycle-actions">${!e && !unmanaged ? pickerView(state, blocked, menu) : `<p>${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)} · ${unmanaged ? 'Unmanaged target' : modeLabel(e.mode)}</p>${button('switch', e?.mode === 'stub' ? 'Use as full skill…' : 'Use as stub…', blocked || destinationFor(state).host !== 'local')}${button('update', 'Review workspace update…', blocked || e?.version === s.version)}${button('remove', 'Remove from project…', !!e?.protected || unmanaged || !!s.blocked)}`}</div>
    ${directAddResultView(state)}
    ${!s.accepted ? button('accept', 'Needs review · Review library changes…', !!s.blocked) : ''}
    <details class="source-status"><summary>Source and status</summary><dl><dt>Source</dt><dd>${s.source || 'Local personal library'}</dd><dt>Library review</dt><dd>${s.accepted ? 'Accepted' : 'Needs review'}</dd><dt>Source status</dt><dd>${s.blocked ? 'Blocked by library policy' : 'Available for review'}</dd><dt>Accepted version</dt><dd>${s.accepted ? s.version : s.acceptedVersion}</dd><dt>Project state</dt><dd><span class="pill">${unmanaged ? 'Unmanaged target' : statusFor(s, e)}</span></dd>${e ? `<dt>Exposed version</dt><dd>${e.version}</dd>` : ''}</dl>${unmanaged ? '<p>No recorded Skillager exposure mode or version. Existing files are preserved.</p>' : ''}${s.source ? '<p>External ownership is preserved. Search does not import this skill.</p>' : ''}${state.selectedScope === 'workspace' && e ? button('canonical-definition', 'Open library definition') : ''}</details>${button('read', 'Review content…')}${button('history', 'Version history')}`
}
export function pickerView(state, blocked = false, menu = false) {
  const choice = addChoice(state),
    chosenDestination = destinationFor({ ...state, destination: choice.destination })
  if (menu)
    return `<p>${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)} · Full skill · accepted ${escapeHtml(skillFor(state).version)}</p>${button('add', 'Add to project', blocked)}`
  return `<section class="direct-add-controls"><label>Project<select id="add-destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === choice.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label><label>Agent<select id="add-agent"><option value="codex" ${choice.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${choice.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label><label>Use as<select id="add-mode"><option value="native" ${choice.mode === 'native' ? 'selected' : ''}>Full skill</option><option value="stub" ${choice.mode === 'stub' ? 'selected' : ''} ${chosenDestination.host !== 'local' ? 'disabled' : ''}>Stub</option></select></label>${button('preview-add', currentDirectAdd(state)?.pending ? 'Preparing Add…' : 'Add to project', blocked || !!currentDirectAdd(state)?.pending || !!state.directAddUncertain)}<small id="add-route">${escapeHtml(chosenDestination.host)} · ${escapeHtml(chosenDestination.path)} · accepted ${escapeHtml(skillFor(state).version)}</small>${state.samplePrerequisites?.length ? `<p class="notice">Declared runtime requirements: ${escapeHtml(state.samplePrerequisites.join(', '))}. Not checked on this host; explicit review is required.</p>` : ''}</section>`
}
export const sampleDiff = `<pre class="diff">  ## Review steps\n<span class="del">− Check the rollback plan.</span><span class="add">+ Verify rollback preserves existing data.</span><span class="add">+ Call out blocking operations before approval.</span></pre>`
export function previewView(state, preview) {
  state = {
    ...state,
    destination: preview.destination,
    agent: preview.agent,
    library: { ...state.library, id: preview.libraryId, path: preview.libraryPath },
  }
  const s = skillFor(state, preview.id),
    e = JSON.parse(preview.target || 'null')
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
    : `${removing ? 'Remove' : e ? 'Replace' : 'Create'} skillager.materialized.yaml`
  return `<h2 id="dialog-title">${label} · ${s.id}</h2><p>Review these changes before confirming.</p>
    ${accepting ? `<div class="notice">This accepts the exact reviewed library version. Workspace copies stay unchanged.</div>${sampleDiff}<p>Scan: low · Lint: passed · No override requested</p>` : `<p class="review-summary">${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)} · ${modeLabel(preview.mode)}</p><p>${removing ? 'Remove this project copy; keep the library skill.' : e ? 'Change this existing managed copy.' : 'Create a new project copy at the absent destination.'}</p>`}
    ${!accepting && ['update', 'switch'].includes(preview.action) ? sampleDiff : ''}
    <details class="complete-effects" open><summary>Complete affected files</summary><ul>${accepting ? `<li>Record exact library approval and content history.</li><li>No workspace file writes.</li>` : removing ? `<li>Remove SKILL.md</li><li>${recordEffect}</li><li>Remove the empty skill folder.</li><li>No library or other workspace writes.</li>` : `<li>${e ? 'Replace unchanged managed' : 'Create'} SKILL.md</li><li>${recordEffect}</li><li>${e ? 'Retain' : 'Create'} the skill folder.</li><li>Supporting instructions: none in this sample package.</li>`}</ul></details>
    <details class="technical-details"><summary>Technical details</summary><p>Source: Local · ${escapeHtml(state.library.path)}/skills/${escapeHtml(s.id)}. Source hash/version: ${escapeHtml(preview.version)}.</p>${!accepting ? `<p>Exact target: ${escapeHtml(destinationFor(state).host)} · ${escapeHtml(target)}. Existing version: ${escapeHtml(e?.version || 'absent')}. File modes 0644; target root 0755.</p>` : ''}<p>Token binds the complete source and target state. All listed project files are relative to the exact target above.</p></details>
    ${remote && !accepting ? `<div class="notice">hvir checks this workspace before applying changes and preserves files changed here. Full skill only; no remote Skillager installation. Runtime requirements: ${state.samplePrerequisites?.length ? escapeHtml(state.samplePrerequisites.join(', ')) + ' · declared, not checked on this host' : 'none declared in this sample'}.</div>` : ''}
    ${protectedTarget ? `<div class="notice">${typeof protectedTarget === 'string' ? protectedTarget : 'Already added'}: preserve this target. Ordinary replacement and removal are unavailable.</div>` : ''}
    <small>Sample preview · no real files will change in this study.</small>
    <footer>${button('close', 'Cancel')}${button('apply', label, !!protectedTarget)}</footer>`
}

export function skillsRailView(state) {
  if (!state.enabled) return ''
  const pending = state.curation
    ? state.curation.sources.filter((s) => s.preserved && !s.libraryAccepted).length
    : state.skills.filter((s) => !s.accepted).length
  const updates = state.curation
    ? state.curation.sources.filter(
        (s) =>
          s.projectPresent &&
          s.managed &&
          s.preserved &&
          s.libraryAccepted &&
          s.exposedVersion !== s.libraryVersion,
      ).length
    : state.skills.filter(
        (s) => statusFor(s, exposuresFor(state)[s.id]) === 'Workspace copy behind',
      ).length
  if (!state.connected)
    return `<div id="content">${catalogView(state)}<p id="connection-label">Skillager disconnected</p></div>`
  const section = (scope, title) =>
    `<section class="explorer-section ${state.explorerOpen[scope] ? 'is-open' : ''}" id="explorer-${scope}"><div class="explorer-heading-row"><button class="explorer-heading" id="${scope === 'library' ? 'library' : 'workspace'}-nav" data-perspective="${scope}" aria-expanded="${state.explorerOpen[scope] && !state.results && !state.searching}"><span aria-hidden="true">${state.explorerOpen[scope] && !state.results && !state.searching ? '⌄' : '›'}</span> ${title}</button><button class="header-refresh" data-action="refresh" aria-label="Refresh ${title}" aria-busy="${!!state.refreshing}" title="${escapeHtml(state.lastChecked)}">↻</button></div><div class="explorer-scroll" ${state.explorerOpen[scope] && !state.results && !state.searching ? '' : 'hidden'}>${catalogView({ ...state, perspective: scope, results: null, submittedQuery: '', searching: false })}</div></section>`
  return `<div class="explorer-tools">${searchView(state)}<details class="target-controls"><summary>Project actions · ${agentLabel(state.agent)}</summary><div class="rail-controls"><label>Active project<select id="destination">${destinations.map((d) => `<option value="${d.id}" ${d.id === state.destination ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('')}</select></label><label>Action agent<select id="agent"><option value="codex" ${state.agent === 'codex' ? 'selected' : ''}>Codex</option><option value="claude" ${state.agent === 'claude' ? 'selected' : ''}>Claude Code</option></select></label></div>${button('refresh', 'Refresh')}<p id="freshness">${escapeHtml(state.lastChecked)}</p><label>Review filter<select id="filter"><option value="all">All metadata</option><option value="pending" ${state.filter === 'pending' ? 'selected' : ''}>Pending review</option></select></label></details></div>
    <div id="content" class="skill-explorer">${state.results || state.searching ? `<section class="explorer-search-results">${catalogView(state)}</section>` : ''}${section('workspace', 'In this project')}${section('library', 'Your library')}</div>
    <p id="observation-notice" role="status">${state.refreshError ? 'Stale observation · ' + escapeHtml(state.refreshError) + ' · Retry with Refresh' : ''}</p><div class="feature-badges"><span id="review-count">${pending} library review${pending === 1 ? '' : 's'}</span><span id="updates-count">${updates} project update${updates === 1 ? '' : 's'}</span></div><span id="connection-label" hidden>Local Skillager connected</span>`
}
export function reviewView(state) {
  const s = skillFor(state)
  return `<h2>Review content · ${s.id}</h2><div class="target">${s.source || `Local · ${state.library.path}/skills/${s.id}`}<p>Reviewed snapshot: ${s.version}</p></div><h3>SKILL.md · sample instructions</h3><p>Read the proposed change and its tests. Verify rollback preserves existing data.</p><p>Full tree: SKILL.md only in this sample. Supporting files and executable modes must be reviewable before production acceptance.</p>${!s.accepted ? sampleDiff : ''}<div class="notice">Content review does not approve or expose this skill.</div>${button('metadata', 'Back to current file')}`
}

function projectWorkspaceView(state) {
  if (destinationFor(state).host !== 'local')
    return '<div class="notice"><h2>Project setup unavailable over SSH</h2><p>Existing-project discovery and Working setup require the local CLI. Managed SSH Full skill delivery remains available.</p></div>'
  const sample = projectSampleFor(state)
  const readiness = sample.observed
  const running = state.setupTerminals.some(
    (t) => t.key === exposureKey(state) && t.running,
  )
  return `${
    readiness.state === 'Ready' && !state.setupOpen
      ? button('show-project-setup', 'Project setup…')
      : `<section class="project-setup"><h2>Project setup</h2><p>${escapeHtml(destinationFor(state).label)} · ${agentLabel(state.agent)}</p>
    <p id="project-readiness">${escapeHtml(readiness.state)} · Working: ${escapeHtml(readiness.working)}</p>
    <p>Open a new terminal for Skillager setup and Working for ${agentLabel(state.agent)}.</p>
    <code>skillager setup --agent ${state.agent}</code>
    ${readiness.state !== 'Ready' ? button('project-setup', state.pendingProjectSetup ? 'Opening new terminal…' : 'Set up in terminal', !!state.pendingProjectSetup || running) : ''}
    ${button('refresh', 'Refresh status')}
    <small>Skillager handles review decisions in the terminal.</small></section>`
  }
    <section id="project-skill-list">${
      sample.metadataUnavailable
        ? '<p>Project skill metadata is unavailable.</p>'
        : sample.rows
            .filter((row) => row.projectPresent !== false)
            .map(
              (row) =>
                `<div class="skill-row" data-native-row="${row.id}"><button data-native="${row.id}"><span class="skill-name">${instructionIcon}${row.id}</span><small> ${copyGlyphs(row.agent, 'Original')} · ${row.review}</small></button><button class="more" data-native-actions="${row.id}" aria-label="Actions for ${row.id}">⋯</button></div>`,
            )
            .join('') || '<p>No project skills reported by Skillager.</p>'
    }</section>
    ${
      Object.entries(exposuresFor(state))
        .map(
          ([id, exposure]) =>
            `<div class="skill-row"><button data-select="${id}"><span class="skill-name">${instructionIcon}${id}</span><small>Managed copy · ${modeLabel(exposure.mode)} · ${statusFor(skillFor(state, id), exposure)}</small></button></div>`,
        )
        .join('') || '<p>No managed copies.</p>'
    }`
}
export function nativeProjectDetailView(state) {
  const row = projectSampleFor(state)?.rows.find((r) => r.id === state.nativeSelected)
  if (!row) return '<p>Project metadata is unavailable for this selection.</p>'
  const folder = row.agent === 'codex' ? '.agents' : '.claude'
  return `<article class="details"><h2>${row.id}</h2><p>${row.description}</p><p>Project native · Unmanaged · ${agentLabel(row.agent)}</p><p>${row.review}</p><code>Local · ${destinationFor(state).path}/${folder}/skills/${row.id}</code><p>Existing project files are preserved. Their presence does not authorize managed Add, Update or Remove.</p><p>Use Set up in terminal for Skillager’s project review decisions.</p><div class="lifecycle-actions"><button disabled>Use as full skill…</button><button disabled>Use as stub…</button><button disabled>Group in router…</button><button data-native-files-id="${row.id}">Remove in Files…</button><button data-native-actions="${row.id}">Actions…</button></div></article>`
}
export function projectTerminalView(state) {
  const terminal = state.setupTerminals.find((t) => t.id === state.selectedTerminal)
  if (!terminal) return ''
  return `<header>Shell · project setup · ${agentLabel(terminal.agent)} <button data-terminal="ordinary">Back to original terminal</button></header><code>Local · ${terminal.destination.path}</code><pre>${escapeHtml(terminal.command)}

${terminal.running ? 'Interactive Skillager setup is running. Answer its prompts here.' : terminal.recovered ? 'Recovered shell. Setup was not restarted.' : 'Command exited with code 0. The terminal remains yours.'}</pre><small>Terminal illustration only · no process launched. Recovery never replays this command.</small>`
}
