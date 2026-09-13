import {
  curationSource,
  curationRouter,
  curationRefusal,
  canonicalRefusal,
  curationTarget,
  standaloneCopyPresent,
} from './curation-model.mjs'
import { agentLabel } from './model.mjs'
const escape = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const action = (name, label, disabled = false) =>
  `<button data-curate="${name}" ${disabled ? 'disabled' : ''}>${label}</button>`
const close = '<button data-action="close">Cancel</button>'
const projectRoot = (state) =>
  state.destination === 'local-review'
    ? '/work/hvir-worktrees/database-review'
    : '/work/hvir'
export function curationCatalogView(state) {
  if (state.perspective === 'workspace' && state.destination === 'remote-main')
    return '<p>SSH workspace catalogs are unavailable. Your local library remains available for Full delivery.</p>'
  const c = state.curation,
    library = state.perspective === 'library',
    libraryEmpty = !c.sources.some((row) => row.preserved),
    rows =
      state.results ??
      c.sources.filter(
        (row) =>
          (library ||
            state.browseAgent === 'all' ||
            !(row.projectAgent ?? row.agent) ||
            (row.projectAgent ?? row.agent) === state.browseAgent) &&
          (library ? row.preserved : row.projectPresent && row.mode !== 'Router member'),
      )
  const rowView = (row) => {
    const agent = row.projectAgent ?? row.agent,
      scope = row.resultScope ?? state.perspective,
      fromLibrary = scope === 'library',
      key = `${state.perspective}:${row.id}`,
      open = state.expandedSkills[key],
      linkedCopy = fromLibrary && !state.results && row.projectPresent,
      status = fromLibrary
        ? !row.libraryAccepted
          ? 'Review'
          : row.conflict
            ? 'Conflict'
            : row.managed && row.exposedVersion !== row.libraryAcceptedVersion
              ? 'Project update'
              : ''
        : row.targetProtected
          ? 'Modified'
          : row.managed
            ? row.libraryAccepted && row.exposedVersion !== row.libraryAcceptedVersion
              ? 'Update'
              : ''
            : !row.approved || row.originBlocked || row.version !== row.approvedVersion
              ? 'Review'
              : '',
      selected = c.selected === row.id && !c.selectedRouter && c.selectedScope === scope
    return `<div class="skill-row ${selected ? 'selected' : ''}" ${fromLibrary ? 'data-library-row' : 'data-curation-row'}="${row.id}" data-row-scope="${scope}">${linkedCopy ? `<button class="disclosure" data-expand="${key}" aria-expanded="${!!open}" aria-label="Related copies of ${row.name}">${open ? '⌄' : '›'}</button>` : '<span class="tree-icon" aria-hidden="true">◇</span>'}<button data-curation-select="${row.id}" title="${row.name}"><span class="skill-name">${row.name}</span><small>${row.resultScope ? (fromLibrary ? 'Your library' : row.origin) : library ? '' : `${agent === 'claude' ? 'Claude' : 'Codex'} · ${row.mode === 'Full skill' ? 'Full' : row.mode}`}</small>${status ? `<span class="row-status">${status}</span>` : ''}</button><button class="more" data-curation-menu="${row.id}" aria-label="Actions for ${row.name}">⋯</button></div>${linkedCopy && open ? `<div class="explorer-child"><button data-curation-select="${row.id}" data-row-scope="workspace">↳ ${agentLabel(agent)} · ${row.mode} · In this project</button></div>` : ''}`
  }
  return `${state.submittedQuery ? `<p class="curation-search-status" role="status">${state.searching ? 'Searching…' : `${rows.length} results`} for “${escape(state.submittedQuery)}” · ${state.scope === 'personal' ? 'Your library' : 'Available to this project'}</p>` : ''}
    ${library && !libraryEmpty ? `<details class="library-actions"><summary>Library actions</summary>${action('sync', 'Sync approved skills…')}</details>` : ''}
    ${library && libraryEmpty && !state.results ? `<p>Your library has no preserved skills.</p>${action('sync', 'Sync approved skills…')}` : !rows.length ? '<p>No skills match this view.</p>' : ''}
    <div class="${library ? 'curation-library-list' : 'curation-list'}">${rows.map(rowView).join('')}</div>
    ${
      !library && !state.results
        ? c.routers
            .filter(
              (router) =>
                router.members.length &&
                (state.browseAgent === 'all' || router.agent === state.browseAgent),
            )
            .map((router) => {
              const key = `router:${router.id}`,
                open = state.expandedSkills[key]
              return `<section class="router-group"><div class="skill-row" data-router-row="${router.id}"><button class="disclosure" data-expand="${key}" aria-expanded="${!!open}" aria-label="Members of ${escape(router.name)}">${open ? '⌄' : '›'}</button><button data-curation-router="${router.id}"><span class="skill-name">${escape(router.name)}</span><small>${agentLabel(router.agent)} · Router ${router.members.length}</small></button><button class="more" data-router-menu="${router.id}" aria-label="Actions for ${escape(router.name)}">⋯</button></div><div class="explorer-child" ${open ? '' : 'hidden'}>${router.members.map((id) => `<button data-curation-select="${id}" data-row-scope="workspace">◇ ${curationSource(state, id).name} · Router member</button>`).join('')}</div></section>`
            })
            .join('')
        : ''
    }`
}
export function curationDetailView(state) {
  const c = state.curation,
    router = curationRouter(state)
  if (c.selectedRouter)
    return `<article class="details curation-details"><h2>${escape(router.name)}</h2><p>${agentLabel(router.agent)} · Router · Membership reported by Skillager</p><ul>${router.members.map((id) => `<li>${curationSource(state, id).name} · ${id}</li>`).join('')}</ul><p>Project tag: ${escape(router.tag)}</p>${action('set-members', 'Edit members…')}${action('ungroup', 'Ungroup…')}${action('remove-router', 'Remove router from this project…')}<p>Review every standalone copy and router effect. Ungrouping retains the project tag.</p></article>`
  const row = curationSource(state),
    canonicalSelection = c.selectedScope === 'library' || row.managed,
    primaryApproval =
      row.managed && c.selectedScope !== 'library'
        ? `Accepted project copy · ${row.exposedVersion}`
        : canonicalSelection
          ? canonicalRefusal(row)
            ? 'Library changes need review'
            : `Accepted library version · ${row.libraryAcceptedVersion}`
          : row.approved && !row.originBlocked && row.version === row.approvedVersion
            ? `Approved original · ${row.approvedVersion}`
            : 'Original needs review',
    canReviewLibrary =
      canonicalSelection ||
      (row.preserved &&
        row.approved &&
        row.libraryVersion === row.version &&
        row.version === row.approvedVersion)
  return `<article class="details curation-details"><header><h2>${row.name}</h2>${action('menu', 'Actions…')}</header><p>${row.description}</p>${state.curation.lastEffect ? `<p role="status">${escape(state.curation.lastEffect)}</p>` : ''}<dl><dt>Selected copy</dt><dd>${row.managed && c.selectedScope !== 'library' ? 'Managed project copy' : canonicalSelection ? 'Canonical library source' : `Project original · ${agentLabel(row.projectAgent ?? row.agent)}`}</dd><dt>Approval</dt><dd id="curation-approval">${primaryApproval}</dd><dt>Library preservation</dt><dd>${row.preserved ? `Local · ${state.library.path}/skills/synced-${row.id} · ${row.libraryVersion}` : 'Not preserved yet'}</dd><dt>Original exposure</dt><dd>${row.projectPresent ? row.mode : 'Not in this project'} · ${row.managed ? 'Managed copy' : 'Original source'}</dd></dl><details class="provenance"><summary>Source and approval lineage</summary><p>Original ${row.origin} decision (${row.approved && !row.originBlocked && row.version === row.approvedVersion ? 'current' : 'changed or blocked'}): ${row.origin === 'Project native' ? 'project-only' : 'global'} · ${row.id} · ${row.approvedVersion}. ${row.libraryAcceptedVersion ? `Derived accepted library version: ${row.libraryAcceptedVersion} · reusable across projects. Current library version: ${row.libraryVersion}. Original scope and actual decision evidence retained.` : 'No derived library acceptance yet.'}</p></details>${state.reviewOpen && canReviewLibrary ? `<section class="review"><h3>Reviewed sample content</h3><p>Local · ${state.library.path}/skills/synced-${row.id} · ${row.libraryVersion}</p><pre id="curation-body"># ${escape(row.name)}\n\nSample instructions for ${escape(row.id)}.</pre></section>` : canReviewLibrary ? action('review', 'Review content') : row.origin === 'Project native' && row.projectPresent ? action('review-files', 'Review in Files…') : '<p>Review this source with Skillager in your local terminal.</p>'}${canonicalSelection ? (canonicalRefusal(row) ? `<p class="notice">${canonicalRefusal(row)}</p>` : '') : curationRefusal(state, row) ? `<p class="notice">${curationRefusal(state, row)}</p>` : ''}</article>`
}
export function curationMenuView(state) {
  const row = curationSource(state),
    reason = curationRefusal(state, row),
    present = row.projectPresent,
    member = row.mode === 'Router member',
    removeReason = curationRefusal(state, row, 'remove'),
    canRemove = present && !member && !removeReason,
    library = state.curation.selectedScope === 'library'
  return `<h2 id="dialog-title">Actions · ${row.name}</h2><p>${row.projectAgent || row.agent ? agentLabel(row.projectAgent ?? row.agent) : 'Your library'} · ${present ? row.mode : 'Not in this project'}</p><h3>This project</h3>
    ${!present ? action('add', 'Add to this project…', !!curationRefusal(state, row, 'add')) : action('full', 'Full skill…', !!reason || member) + action('stub', 'Stub…', !!reason || member) + action('router', 'Group in router…', !!reason) + action('update', 'Update…', !!reason || member || !row.managed || row.exposedVersion === row.libraryVersion) + (canRemove ? action('remove', 'Remove from this project…') : member ? '<p>Edit router members to restore or remove this membership.</p>' : action('files-remove', 'Remove in Files…'))}
    ${(!present ? canonicalRefusal(row) : reason) ? `<p class="notice">${!present ? canonicalRefusal(row) : reason}</p>` : ''}${library ? `<p>Canonical library versions remain when project copies change.</p>` : ''}<h3>Your library</h3>${action('sync', 'Sync approved skills…')}<p>Sync preserves originals; changing an original requires separate review.</p><footer><button data-action="close">Close</button></footer>`
}
export function curationRouterMenuView(state) {
  const router = curationRouter(state)
  return `<h2 id="dialog-title">Actions · ${escape(router.name)}</h2><p>${agentLabel(router.agent)} · ${router.members.length} members</p>${action('set-members', 'Edit members…')}${action('ungroup', 'Ungroup…')}${action('remove-router', 'Remove router from this project…')}<p>Removing only the router creates no standalone copies. Library versions and the curated tag remain.</p><footer><button data-action="close">Close</button></footer>`
}
export function curationPickerView(state, kind) {
  const c = state.curation,
    row = curationSource(state),
    router = curationRouter(state)
  const modes =
    '<select id="curation-mode"><option>Full skill</option><option>Stub</option></select>'
  if (kind === 'add')
    return `<h2 id="dialog-title">Add ${row.name} to this project</h2><p>Local · ${projectRoot(state)}</p><label>Agent<select id="curation-add-agent"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><label>Mode ${modes}</label><footer>${close}${action('add-preview', 'Preview changes')}</footer>`
  if (kind === 'ungroup')
    return `<h2 id="dialog-title">Ungroup ${escape(router.name)}</h2><p>${agentLabel(router.agent)} · ${router.members.map((id) => curationSource(state, id).name).join(', ')}</p><label>Standalone copies ${modes}</label><p>Remove this router after preparing the selected standalone copies. Keep project tag ${escape(router.tag)} and its curated members.</p><footer>${close}${action('ungroup-preview', 'Preview changes')}</footer>`
  if (kind === 'set-members')
    return `<h2 id="dialog-title">Edit ${escape(router.name)} members</h2><p>${agentLabel(router.agent)} · ${escape(router.tag)}</p><div id="router-member-choices">${c.sources
      .filter((source) => (source.projectAgent ?? source.agent) === router.agent)
      .map(
        (source) =>
          `<label class="inline"><input type="checkbox" data-router-member="${source.id}" ${router.members.includes(source.id) ? 'checked' : ''} ${curationRefusal(state, source, standaloneCopyPresent(source) ? 'native' : 'canonical') && !router.members.includes(source.id) ? 'disabled' : ''}>${source.name} · ${standaloneCopyPresent(source) ? source.mode : 'No standalone copy to remove'}${curationRefusal(state, source, standaloneCopyPresent(source) ? 'native' : 'canonical') ? ` · ${curationRefusal(state, source, standaloneCopyPresent(source) ? 'native' : 'canonical')}` : ''}</label>`,
      )
      .join(
        '',
      )}</div><label>Departing members<select id="curation-mode"><option>Full skill</option><option>Stub</option><option>Remove from project</option></select></label><p>Selected added standalone copies will be replaced by router membership. Other copies stay unchanged.</p><footer>${close}${action('members-preview', 'Preview changes')}</footer>`
  return `<h2 id="dialog-title">Group ${row.name}</h2><p>${agentLabel(row.projectAgent ?? row.agent)} · Local · ${projectRoot(state)}</p><label>Router<select id="curation-group"><option value="new">Create a named router</option>${c.routers
    .filter(
      (group) => group.agent === (row.projectAgent ?? row.agent) && group.members.length,
    )
    .map((group) => `<option value="${group.id}">${escape(group.name)}</option>`)
    .join(
      '',
    )}</select></label><label>New router name<input id="curation-name" value="New router" maxlength="80"></label><p id="router-existing-members">New group; no existing members.</p><p>Selected member: ${row.name} · synced-${row.id}</p><label class="inline"><input id="curation-replace" type="checkbox" checked>Replace this selected standalone copy: Local · ${curationTarget(state, row)}</label><p>Leaving it unchecked retains this copy alongside the router. Preview does not create a tag or change files.</p><footer>${close}${action('router-preview', 'Preview changes')}</footer>`
}
export function curationPreviewView(state, plan) {
  if (plan.refusal)
    return `<h2 id="dialog-title">Action unavailable</h2><p>${plan.refusal}</p><footer><button data-action="close">Close</button></footer>`
  const rows = plan.ids.map((id) => curationSource(state, id)),
    managedRemoval = plan.action === 'remove' && rows[0].managed
  const effects = []
  if (!plan.router) {
    const row = rows[0]
    if (plan.action === 'remove')
      effects.push(
        `Remove the exact original ${curationTarget(state, row)}/SKILL.md${row.managed ? ' and skillager.materialized.yaml' : ''}, then its empty root (0755). ${row.managed ? 'The unchanged managed target matches its recorded files and modes; canonical library state is retained without approving it.' : 'Complete approved original bytes and file mode 0644 are preserved in the library; no extra entries exist in this sample.'}`,
      )
    else
      effects.push(
        `${plan.action === 'add' ? 'Create' : 'Replace'} ${curationTarget(state, plan.action === 'add' ? { ...row, projectAgent: plan.agent, projectId: `lib-${row.id}` } : row)}/SKILL.md with ${plan.mode}; ${row.managed ? 'replace' : 'create'} skillager.materialized.yaml. Keep root mode 0755; file modes 0644.`,
      )
  }
  for (const id of plan.replacements) {
    const row = curationSource(state, id)
    effects.push(
      `Remove selected standalone ${curationTarget(state, row)}/SKILL.md${row.managed ? ' and skillager.materialized.yaml' : ''}; remove its empty directory (0755). Its complete original bytes/modes are preserved; no extra entries in this sample.`,
    )
  }
  for (const id of plan.afterMembers ?? []) {
    if (plan.router.members.includes(id) || plan.replacements.includes(id)) continue
    const row = curationSource(state, id)
    effects.push(
      standaloneCopyPresent(row)
        ? `Keep the existing ${row.mode} standalone ${curationTarget(state, row)} unchanged alongside this router.`
        : `No standalone copy to remove at ${curationTarget(state, row)}; add this source only through router membership.`,
    )
  }
  for (const id of plan.departures)
    effects.push(
      plan.retainedStandalone.includes(id)
        ? `Remove ${id} from this router's membership; keep its existing ${curationSource(state, id).mode} standalone ${curationTarget(state, curationSource(state, id))} unchanged, without adoption or approval.`
        : plan.mode === 'Remove from project'
          ? `Remove ${id} from this router's project membership; create no standalone copy. Retain the library and unselected copies.`
          : `Create or reuse unchanged ${plan.mode}: ${curationTarget(state, curationSource(state, id))}/SKILL.md and skillager.materialized.yaml; root 0755, files 0644.`,
    )
  if (plan.router) {
    effects.push(
      `${plan.afterMembers.length ? 'Create or update' : 'Remove'} ${curationTarget(state, plan.router)}/SKILL.md and skillager.materialized.yaml; root 0755, files 0644.`,
    )
    effects.push(
      `Project tag ${plan.router.tag}: ${plan.tagPolicy === 'retained' ? 'retained with its curated members; no tag-file write' : `${plan.tagPolicy} selected membership in ${projectRoot(state)}/.skillager/tags.json (0644); preserve every unrelated tag`}.`,
    )
  }
  return `<h2 id="dialog-title">Review ${plan.action === 'remove' ? 'removal from this project' : plan.router ? (plan.action === 'remove-router' ? 'router removal' : plan.action === 'ungroup' ? 'router ungrouping' : 'router membership') : `change to ${plan.mode}`}</h2><p>Local · ${projectRoot(state)} · ${agentLabel(plan.agent)}</p>${plan.router ? `<p>Router: ${escape(plan.router.name)} · returned tag ${escape(plan.router.tag)} · membership version ${plan.router.version}</p><p>After: ${plan.afterMembers.map((id) => curationSource(state, id).name).join(', ') || (plan.action === 'remove-router' ? 'No router; no standalone copies created' : 'No router; standalone copies')}</p>` : ''}<h3>${managedRemoval ? 'Library retained' : 'Preserved approved sources'}</h3>${!plan.router ? `<p>Existing selected copy: ${rows[0].projectPresent ? `${rows[0].mode} · ${rows[0].exposedVersion}` : 'absent'}</p>` : ''}<ul>${rows
    .filter(
      (row) =>
        !plan.retainedStandalone.includes(row.id) &&
        !(plan.mode === 'Remove from project' && plan.departures.includes(row.id)),
    )
    .map(
      (row) =>
        `<li>Local · ${state.library.path}/skills/synced-${row.id} · ${row.libraryVersion}</li>`,
    )
    .join(
      '',
    )}</ul><h3>Every sample effect</h3><ul>${effects.map((effect) => `<li>Local · ${escape(effect)}</li>`).join('')}</ul><p>Library versions and unselected copies stay unchanged. Any required source version, selected target, name or membership change refuses this preview.</p><small>Sample plan only. Interrupted changes may retain partial effects; inspect the actual result before another action.</small><footer>${close}${action('apply', 'Confirm exact changes')}</footer>`
}
export function curationSyncView(state) {
  const c = state.curation ?? { outcomes: [] }
  return `<h2 id="dialog-title">Sync approved skills</h2><p>Preserve currently approved project, environment, package, collection and global sources in Local · ${state.library.path}. These exact approved copies are reusable across projects, with the original approval scope and evidence retained in their lineage. Originals stay in place. Reads and refresh do not perform this action.</p>${c.outcomes.length ? `<ul id="sync-outcomes">${c.outcomes.map((row) => `<li>${row.origin}${row.agent ? ` · ${agentLabel(row.agent)}` : ''} · ${row.name} (${row.id}): ${row.outcome}</li>`).join('')}</ul>` : '<p>Customized, pinned or conflicting library copies are preserved. Pending or stale sources are skipped.</p>'}<footer><button data-action="close">Close</button>${c.syncUncertain ? action('sync-status', 'Check library state') : action('sync-confirm', 'Sync approved skills')}</footer>`
}
