// Sample state only. This module has no CLI, filesystem, or network authority.
export const libraries = [
  { id: 'library-7f29', path: '/home/example/.skillager/library', git: true },
  { id: 'library-b812', path: '/home/example/.skillager/library-new', git: true },
]
export const destinations = [
  { id: 'local-main', label: 'Local · hvir / main', host: 'local', path: '/work/hvir' },
  {
    id: 'local-review',
    label: 'Local · hvir / agent/database-review',
    host: 'local',
    path: '/work/hvir-worktrees/database-review',
  },
  {
    id: 'remote-main',
    label: 'SSH · build-host / research / main',
    host: 'build-host',
    path: '/srv/research',
  },
]
export const seeds = [
  {
    id: 'migration-review',
    description: 'Review schema changes and rollback safety.',
    tags: 'Database · Review',
    version: 'c82a19f',
    match: 'Body',
    query: 'deadlock',
    accepted: true,
  },
  {
    id: 'pr-review',
    description: 'Review correctness and scope of a pull request.',
    tags: 'Git · Review',
    version: 'b19d04a',
    accepted: true,
  },
  {
    id: 'incident-notes',
    description: 'Build an incident timeline and follow-up.',
    tags: 'Operations · Writing',
    version: 'e417ab2',
    accepted: true,
  },
  {
    id: 'deploy-checklist',
    description: 'Verify deployment changes and rollback steps.',
    tags: 'Release',
    version: 'draft-d901e37',
    acceptedVersion: '83fe091',
    accepted: false,
  },
  {
    id: 'release-checklist',
    description: 'Check release notes and versioning.',
    tags: 'Release',
    version: 'a630ce8',
    accepted: true,
  },
  {
    id: 'test-design',
    description: 'Choose tests at the behavior boundary.',
    tags: 'Testing',
    version: 'f806b39',
    accepted: true,
  },
]
const external = [
  {
    id: 'deadlock-analysis',
    description: 'Investigate transaction locks.',
    tags: 'Database',
    version: 'd62e911',
    accepted: true,
    source: 'Company database collection',
    query: 'deadlock',
    match: 'Title',
  },
  {
    id: 'transaction-diagnostics',
    description: 'Diagnose deadlock and retry failures.',
    tags: 'Database',
    version: '22c694b',
    accepted: true,
    source: 'Company operations collection',
    query: 'deadlock',
    match: 'Description',
  },
]
export function initialState() {
  return {
    enabled: false,
    connected: false,
    missing: false,
    // External CLI availability is fixture input, never changed by Check again.
    sampleCliAvailable: true,
    // True only after a successful empty personal-inventory observation.
    empty: false,
    libraryMissing: false,
    setup: { path: '/home/example/.skillager/library', git: true, status: 'idle' },
    // The study supplies these external outcomes; no user library is touched.
    sampleSetupOutcome: 'success',
    sampleSetupStatusUnavailable: false,
    sampleInitializedLibrary: null,
    library: libraries[0],
    railMode: 'files',
    viewer: 'document',
    lastOrdinaryViewer: 'document',
    skillsOpen: false,
    reviewOpen: false,
    perspective: 'library',
    destination: 'local-main',
    agent: 'codex',
    scope: 'personal',
    filter: 'all',
    query: '',
    submittedQuery: '',
    results: null,
    searching: false,
    selected: 'migration-review',
    lastChecked: 'Not checked',
    unmanagedTargets: {},
    generation: 0,
    skills: globalThis.structuredClone(seeds),
    exposures: {
      'local-main/codex': {
        'migration-review': { version: '7da204b', mode: 'native' },
        'pr-review': { version: 'b19d04a', mode: 'stub' },
        'deploy-checklist': { version: '83fe091', mode: 'stub' },
        'release-checklist': {
          version: 'a630ce8',
          mode: 'native',
          protected: 'Modified here',
        },
        'test-design': { version: 'f806b39', mode: 'native', protected: 'Pinned' },
      },
    },
  }
}
export const skillFor = (state, id = state.selected) =>
  [...state.skills, ...external].find((s) => s.id === id)
export const destinationFor = (state) =>
  destinations.find((d) => d.id === state.destination)
export const exposureKey = (state) => `${state.destination}/${state.agent}`
export const exposuresFor = (state) => state.exposures[exposureKey(state)] || {}
export const unmanagedFor = (state, id = state.selected, key = exposureKey(state)) =>
  state.unmanagedTargets[key]?.[id] === true
export function skillsVisible(state) {
  return state.enabled && (state.railMode === 'skills' || state.viewer === 'skills')
}
export function automaticRefreshAllowed(state, visible, focused) {
  return state.connected && skillsVisible(state) && visible && focused
}
export const modeLabel = (mode) => (mode === 'stub' ? 'Stub' : 'Full skill')
export const agentLabel = (agent) => (agent === 'codex' ? 'Codex' : 'Claude Code')
export function targetPath(state, skill) {
  return `${destinationFor(state).path}/${state.agent === 'codex' ? '.agents' : '.claude'}/skills/lib-${skill.id}`
}
export function statusFor(skill, exposure) {
  if (!exposure) return 'Not added'
  if (exposure.protected) return exposure.protected
  if (!skill.accepted) return 'Library changes await review'
  return exposure.version === skill.version ? 'Current' : 'Workspace copy behind'
}
export function sampleSearch(state) {
  // Predeclared sample match reasons illustrate CLI output; never performance evidence.
  const rows = state.scope === 'personal' ? state.skills : [...external, ...state.skills]
  const query = state.query.trim().toLowerCase()
  return rows
    .filter(
      (s) =>
        s.accepted &&
        !s.blocked &&
        (!query ||
          `${s.id} ${s.description} ${s.tags} ${s.query || ''}`
            .toLowerCase()
            .includes(query)),
    )
    .map((s) => ({ ...s, match: s.query === query ? s.match : 'Metadata' }))
    .slice(0, 50)
}
export function previewSnapshot(state, action, mode) {
  const skill = skillFor(state)
  return {
    action,
    mode,
    id: skill.id,
    version: skill.version,
    libraryId: state.library.id,
    libraryPath: state.library.path,
    destination: state.destination,
    agent: state.agent,
    generation: state.generation,
    key: exposureKey(state),
    target: JSON.stringify(exposuresFor(state)[skill.id] || null),
  }
}
export function applySample(state, preview) {
  const skill = skillFor(state, preview.id)
  const existing = state.exposures[preview.key]?.[preview.id]
  if (
    !state.connected ||
    state.library.id !== preview.libraryId ||
    state.library.path !== preview.libraryPath ||
    state.generation !== preview.generation ||
    skill.version !== preview.version ||
    (preview.action !== 'accept' && JSON.stringify(existing || null) !== preview.target)
  ) {
    return 'stale'
  }
  if (
    skill.source ||
    skill.blocked ||
    (preview.action !== 'accept' &&
      (existing?.protected || unmanagedFor(state, preview.id, preview.key)))
  )
    return 'protected'
  if (preview.action === 'accept') {
    skill.accepted = true
    skill.version = 'd901e37'
    state.results = null
  } else if (preview.action === 'remove') {
    delete state.exposures[preview.key][preview.id]
  } else {
    if (!skill.accepted || (preview.action === 'add' && existing)) return 'protected'
    state.exposures[preview.key] ||= {}
    state.exposures[preview.key][preview.id] = {
      version: skill.version,
      mode: preview.mode,
    }
  }
  state.generation++
  return 'completed'
}

// Illustrative onboarding outcomes only; Skillager owns real initialization and identity.
export function beginSampleSetup(state) {
  if (!state.enabled || !state.libraryMissing || state.setup.status !== 'idle') return
  state.setup.status = 'creating'
  state.sampleInitializedLibrary =
    state.sampleSetupOutcome === 'error'
      ? null
      : {
          id: 'library-created-sample',
          path: state.setup.path,
          git:
            state.sampleSetupOutcome === 'git-mismatch'
              ? !state.setup.git
              : state.setup.git,
        }
  return state.generation
}
export function finishSampleSetup(state, generation) {
  if (
    !state.enabled ||
    state.generation !== generation ||
    state.setup.status !== 'creating'
  )
    return
  if (state.sampleSetupOutcome === 'error') {
    state.setup.status = 'uncertain'
    state.setup.message =
      'Git initialization failed: permission denied. Library files may have been created.'
    return
  }
  state.library = state.sampleInitializedLibrary
  state.libraryMissing = false
  state.empty = true
  state.skills = []
  state.exposures = {}
  state.setup.status = 'idle'
  if (state.library.git !== state.setup.git) {
    state.setup.message =
      'An existing library was found with a different Git history setting. Review its actual setting before connecting.'
    return
  }
  state.connected = true
  state.setup.message = 'Your personal library is ready.'
}
export function cancelSampleSetup(state) {
  if (state.setup.status !== 'creating') return
  state.setup.status = 'uncertain'
  state.setup.message =
    'Setup was interrupted. Library files or registration may already exist. Check library status before continuing.'
}
export function reconcileSampleSetup(state) {
  if (state.setup.status !== 'uncertain') return
  if (state.sampleSetupStatusUnavailable) {
    state.setup.message =
      'Library status is unavailable. Setup effects remain uncertain; no new initialization can start.'
    return
  }
  state.setup.status = 'idle'
  if (state.sampleInitializedLibrary) {
    state.library = state.sampleInitializedLibrary
    state.libraryMissing = false
    state.empty = true
    state.skills = []
    state.exposures = {}
    state.setup.message =
      'Library found. Review its location and Git history setting, then connect.'
  } else {
    state.setup.message =
      'No registered library was found. Inspect any retained files before choosing Create and connect again.'
  }
}
