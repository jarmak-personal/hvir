import { curationSearchCandidates, publicSearchSample } from './search-sample.mjs'
// Synthetic curation outcomes only: no CLI calls, files, approval policy or real tokens.
export function curationSample({ emptyLibrary = false } = {}) {
  const source = (id, name, agent, origin, extra = {}) => ({
    id,
    logicalIdentity: `sample-source-${id}`,
    name,
    agent,
    origin,
    version: 'approved-v1',
    approvedVersion: 'approved-v1',
    libraryVersion: extra.preserved ? 'approved-v1' : undefined,
    libraryAccepted: !!extra.preserved,
    libraryAcceptedVersion: extra.preserved
      ? (extra.libraryVersion ?? 'approved-v1')
      : undefined,
    approved: true,
    projectPresent: !!agent,
    exposedVersion: 'approved-v1',
    description: `Reusable ${name.toLowerCase()} instructions.`,
    mode: 'Full skill',
    managed: false,
    preserved: false,
    files: ['SKILL.md'],
    ...extra,
  })
  const sample = {
    revision: 0,
    selected: 'native-codex',
    selectedRouter: false,
    // Existing, independently accepted library evidence is available for this conversion.
    sources: [
      source('native-codex', 'Release review', 'codex', 'Project native', {
        preserved: true,
      }),
      source('native-claude', 'Release review', 'claude', 'Project native'),
      source('environment', 'Environment checks', null, 'Environment', {
        preserved: true,
        version: 'approved-v2',
        approvedVersion: 'approved-v2',
        libraryVersion: 'approved-v1',
      }),
      source('package', 'Package review', null, 'Package', { syncFailed: true }),
      source('collection', 'Style guide', null, 'Collection', {
        conflict: true,
        preserved: true,
        libraryVersion: 'customized-v0',
      }),
      source('pending-library', 'Edited library draft', null, 'Collection', {
        preserved: true,
        conflict: true,
        libraryVersion: 'edited-v2',
        libraryAccepted: false,
        libraryAcceptedVersion: 'approved-v1',
      }),
      source('global', 'Global review', 'codex', 'Global', {
        preserved: true,
        managed: true,
        mode: 'Router member',
      }),
      source('extra-files', 'Customized review', 'codex', 'Project native', {
        preserved: true,
        extraFiles: ['notes.local.txt'],
      }),
      source('managed', 'Regression checks', 'codex', 'Project native', {
        preserved: true,
        managed: true,
        version: 'approved-v2',
        approvedVersion: 'approved-v2',
        libraryVersion: 'approved-v2',
      }),
      source('draft', 'New project draft', 'claude', 'Project native', {
        approved: false,
      }),
    ],
    routers: [
      {
        id: 'review-router',
        name: 'Review toolkit',
        agent: 'codex',
        members: ['global'],
        tagMembers: ['global'],
        tag: 'review-toolkit',
        version: 0,
      },
    ],
    routerId: 'review-router',
    outcomes: [],
    unavailable: false,
    uncertain: false,
    lastEffect: '',
    // Original scope is retained; verified derived copies are reusable across projects.
    syncScope: 'derived-reusable-acceptance',
  }
  if (emptyLibrary)
    for (const row of sample.sources) {
      row.preserved = false
      row.conflict = false
      row.libraryAccepted = false
      row.libraryVersion = row.libraryAcceptedVersion = undefined
    }
  return sample
}
export function curationSource(state, id = state.curation.selected) {
  return state.curation.sources.find((row) => row.id === id)
}
export function searchCurationSample(state, submitted) {
  return publicSearchSample(state, submitted, curationSearchCandidates(state))
}
export function syncCurationSample(state) {
  const c = state.curation
  if (c.syncUncertain) return
  if (c.interruptSync) {
    c.interruptSync = false
    c.syncUncertain = true
    c.outcomes = [
      {
        id: 'unknown-result',
        origin: 'Selected sources',
        name: 'Completion unavailable',
        outcome: 'Uncertain · inspect current library state before another write',
      },
    ]
    return
  }
  c.outcomes = c.sources.map((row) => {
    const outcome =
      !row.approved || row.originBlocked || row.version !== row.approvedVersion
        ? 'Skipped · pending or stale approval'
        : row.syncFailed
          ? 'Failed · source approval retained; preservation unavailable'
          : row.conflict ||
              (row.preserved &&
                (!row.libraryAccepted ||
                  row.libraryVersion !== row.libraryAcceptedVersion ||
                  row.libraryBlocked))
            ? 'Conflict · customized library copy preserved'
            : row.preserved
              ? row.libraryVersion === row.version
                ? 'Unchanged'
                : 'Updated'
              : 'Created'
    if (['Created', 'Updated'].includes(outcome)) {
      row.preserved = true
      row.libraryVersion = row.version
      row.libraryAcceptedVersion = row.version
      row.libraryAccepted = true
    }
    return { id: row.id, name: row.name, agent: row.agent, origin: row.origin, outcome }
  })
  c.revision++
}
export function curationTarget(state, row) {
  const root =
    state.destination === 'local-review'
      ? '/work/hvir-worktrees/database-review'
      : '/work/hvir'
  return `${root}/${(row.projectAgent ?? row.agent) === 'claude' ? '.claude' : '.agents'}/skills/${row.projectId ?? row.id}`
}
export function standaloneCopyPresent(row) {
  return row.projectPresent && row.mode !== 'Router member'
}
export function canonicalRefusal(row) {
  if (
    !row.preserved ||
    !row.libraryAccepted ||
    row.libraryVersion !== row.libraryAcceptedVersion
  )
    return 'Review and accept this exact library version before adding or updating project copies.'
  if (row.libraryBlocked) return 'This canonical library version is blocked.'
  return ''
}
function curationAvailability(state) {
  if (state.destination === 'remote-main')
    return 'SSH supports Full delivery; this local curation sample is unavailable here.'
  if (state.curation.unavailable)
    return 'This installed version cannot prepare this action. No changes made.'
  if (state.curation.recoveryRequired)
    return 'Observed staging recovery is still required; further changes stay unavailable.'
  if (state.curation.uncertain)
    return 'A previous result is uncertain. Check the observed state before another action.'
  return ''
}
export function curationRefusal(state, row, authority = 'native') {
  const unavailable = curationAvailability(state)
  if (unavailable) return unavailable
  if (authority === 'retain') return ''
  if (authority !== 'add' && row.targetProtected)
    return 'This project target changed independently; preserve it.'
  if (authority === 'remove' && row.managed) return ''
  if (['add', 'canonical'].includes(authority) || row.managed)
    return canonicalRefusal(row)
  if (!row.approved || row.originBlocked || row.version !== row.approvedVersion)
    return 'Native conversion needs current original approval. Use Files to remove an unwanted original.'
  if (row.conflict)
    return 'The library copy differs from this original. Resolve preservation before native conversion.'
  if (!row.preserved || row.libraryVersion !== row.version)
    return 'Sync this approved source to the personal library before conversion.'
  if (canonicalRefusal(row)) return canonicalRefusal(row)
  if (row.extraFiles?.length)
    return `Preserve ${row.extraFiles.join(', ')} first. The preserved approved snapshot does not cover these original files.`
  return ''
}
function curationSnapshot(state, requirements) {
  const sources = requirements.map(({ id, authority }) => {
    const row = curationSource(state, id)
    if (!row) return { id, missing: true }
    if (authority === 'native') return row
    const target = {
      id,
      projectPresent: row.projectPresent,
      projectAgent: row.projectAgent,
      projectId: row.projectId,
      mode: row.mode,
      exposedVersion: row.exposedVersion,
      targetProtected: row.targetProtected,
    }
    return ['remove', 'retain'].includes(authority)
      ? target
      : {
          ...target,
          preserved: row.preserved,
          libraryAccepted: row.libraryAccepted,
          libraryVersion: row.libraryVersion,
          libraryAcceptedVersion: row.libraryAcceptedVersion,
          libraryBlocked: row.libraryBlocked,
        }
  })
  return JSON.stringify({ sources, routers: state.curation.routers })
}
export function curationRouter(state) {
  return state.curation.routers.find((router) => router.id === state.curation.routerId)
}
export function prepareCurationSample(state, action, options = {}) {
  const unavailable = curationAvailability(state)
  if (unavailable) return { refusal: unavailable }
  const c = state.curation,
    original = curationSource(state),
    row = action === 'add' ? { ...original, projectAgent: options.agent } : original
  let router = curationRouter(state)
  let afterMembers,
    tagPolicy = 'unchanged',
    replacements = [],
    departures = []
  if (['router', 'set-members'].includes(action)) {
    if (options.routerId === 'new') {
      // Simulated public name-resolution reply; production consumes CLI normalization.
      const name = options.name?.trim(),
        tag = name
          ?.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      if (!tag) return { refusal: 'Choose a router name, then request another preview.' }
      if (c.routers.some((group) => group.tag === tag))
        return {
          refusal:
            'That named group already exists. Choose it explicitly or enter another name.',
        }
      router = {
        id: `router-${tag}`,
        name,
        tag,
        agent: row.projectAgent ?? row.agent,
        members: [],
        tagMembers: [],
        version: 0,
      }
    } else router = c.routers.find((group) => group.id === options.routerId)
    if (!router) return { refusal: 'Choose an observed named group.' }
    afterMembers =
      action === 'set-members'
        ? options.members
        : [...new Set([...router.members, row.id])]
    departures = router.members.filter((id) => !afterMembers.includes(id))
    replacements = (options.replace ?? []).filter((id) =>
      standaloneCopyPresent(curationSource(state, id)),
    )
    tagPolicy = c.routers.includes(router) ? 'change' : 'create'
    if (router.shared && JSON.stringify(afterMembers) !== JSON.stringify(router.members))
      return {
        refusal:
          'Another agent or router uses this tag. Choose a different named group; shared membership is preserved.',
      }
  } else if (['ungroup', 'remove-router'].includes(action)) {
    afterMembers = []
    departures = action === 'ungroup' ? [...router.members] : []
    tagPolicy = 'retained'
  }
  const ids = [...new Set(afterMembers ? [...afterMembers, ...departures] : [row.id])]
  const members = ids.map((id) => (id === row.id ? row : curationSource(state, id)))
  if ((!ids.length && action !== 'remove-router') || members.some((member) => !member))
    return { refusal: 'Select an observed, preserved source.' }
  const retainedStandalone = departures.filter((id) =>
    standaloneCopyPresent(curationSource(state, id)),
  )
  if (
    options.mode !== 'Remove from project' &&
    retainedStandalone.some((id) => curationSource(state, id).mode !== options.mode)
  )
    return {
      refusal:
        'A retained standalone copy has a different mode. Convert that exact copy separately with its source and target protections; this membership action cannot adopt or overwrite it.',
    }
  const requirements = members.map((member) => ({
    id: member.id,
    authority: retainedStandalone.includes(member.id)
      ? 'retain'
      : options.mode === 'Remove from project' && departures.includes(member.id)
        ? 'remove'
        : action === 'add'
          ? 'add'
          : action === 'remove' && member.managed
            ? 'remove'
            : afterMembers
              ? replacements.includes(member.id) && !member.managed
                ? 'native'
                : 'canonical'
              : member.managed
                ? 'canonical'
                : 'native',
  }))
  const refusal = requirements
    .map(({ id, authority }) =>
      curationRefusal(state, curationSource(state, id), authority),
    )
    .find(Boolean)
  if (refusal) return { refusal }
  const agent = afterMembers ? router.agent : (row.projectAgent ?? row.agent)
  if (
    !['codex', 'claude'].includes(agent) ||
    members.some((member) => (member.projectAgent ?? member.agent) !== agent)
  )
    return { refusal: 'Choose copies and a router for one concrete agent.' }
  return {
    action,
    ids,
    router: afterMembers ? { ...router, members: [...router.members] } : undefined,
    afterMembers,
    replacements,
    departures,
    retainedStandalone,
    tagPolicy,
    mode:
      options.mode ??
      (action === 'update' ? row.mode : action === 'stub' ? 'Stub' : 'Full skill'),
    destination: state.destination,
    generation: state.generation,
    requirements,
    snapshot: curationSnapshot(state, requirements),
    agent,
  }
}
export function applyCurationSample(state, plan) {
  const c = state.curation
  const unavailable = curationAvailability(state)
  if (unavailable) return unavailable
  if (
    !state.connected ||
    plan.destination !== state.destination ||
    plan.generation !== state.generation ||
    plan.snapshot !== curationSnapshot(state, plan.requirements)
  )
    return 'The source, original target or router membership changed. Nothing applied; review a new preview.'
  if (c.nextUncertain) {
    c.nextUncertain = false
    c.uncertain = true
    return 'Some files may have changed. Check the observed result before another action.'
  }
  for (const { id, authority } of plan.requirements) {
    const refusal = curationRefusal(state, curationSource(state, id), authority)
    if (refusal) return refusal
  }
  if (plan.router) {
    let router = c.routers.find((group) => group.id === plan.router.id)
    if (!router) {
      router = { ...plan.router }
      c.routers.push(router)
    }
    if (plan.action === 'remove-router')
      for (const id of router.members) {
        const source = curationSource(state, id)
        if (source.mode === 'Router member') source.projectPresent = false
      }
    router.members = [...plan.afterMembers]
    if (plan.tagPolicy !== 'retained') router.tagMembers = [...plan.afterMembers]
    router.version++
    c.routerId = router.id
    for (const id of plan.afterMembers) {
      const source = curationSource(state, id)
      if (plan.replacements.includes(id) || !standaloneCopyPresent(source)) {
        source.mode = 'Router member'
        source.managed = true
        source.projectPresent = true
        source.exposedVersion = source.libraryAcceptedVersion
      }
    }
    for (const id of plan.departures) {
      if (plan.retainedStandalone.includes(id)) continue
      const source = curationSource(state, id)
      source.mode = plan.mode
      source.managed = true
      source.projectPresent = plan.mode !== 'Remove from project'
      if (source.projectPresent) source.exposedVersion = source.libraryAcceptedVersion
    }
    if (!router.members.length) c.selectedRouter = false
  } else {
    const row = curationSource(state, plan.ids[0])
    row.mode = plan.mode
    row.managed = true
    row.projectPresent = plan.action !== 'remove'
    if (plan.action === 'add') {
      row.projectAgent = plan.agent
      row.projectId = `lib-${row.id}`
    }
    row.exposedVersion = row.libraryVersion
  }
  c.revision++
  c.lastEffect = `Selected exposure changed; library versions and unrelated copies retained.${plan.tagPolicy === 'retained' ? ' Project tag retained with its curated members.' : ''}`
  return null
}
