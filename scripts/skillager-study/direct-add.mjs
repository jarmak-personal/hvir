// Closed create-only illustration; production uses its existing CLI/SSH token owner.
import {
  previewSnapshot,
  applySample,
  skillFor,
  destinationFor,
  exposuresFor,
  unmanagedFor,
  targetPath,
} from './model.mjs'
import {
  prepareCurationSample,
  applyCurationSample,
  curationSource,
  canonicalRefusal,
  curationTarget,
} from './curation-model.mjs'

export function addSelectionKey(state) {
  const row = state.curation ? curationSource(state) : skillFor(state)
  return JSON.stringify([
    state.library.id,
    state.library.path,
    state.destination,
    state.agent,
    state.nativeSelected,
    state.curation?.selectedRouter,
    state.curation?.selectedMemberRouter,
    state.curation?.selectedScope ?? state.selectedScope ?? 'library',
    row?.id,
    state.curation ? row?.libraryAcceptedVersion : row?.version,
    state.curation ? row?.libraryVersion : row?.accepted,
  ])
}

export function addChoice(state) {
  const key = addSelectionKey(state)
  if (state.addChoice?.key !== key)
    state.addChoice = {
      key,
      destination: state.destination,
      agent: state.agent,
      mode: 'native',
    }
  return state.addChoice
}

export function changeAddChoice(state, id, value) {
  const field = {
    'add-destination': 'destination',
    'add-agent': 'agent',
    'curation-add-agent': 'agent',
    'add-mode': 'mode',
    'curation-mode': 'mode',
  }[id]
  if (!field) return false
  const choice = addChoice(state)
  choice[field] =
    field === 'mode' ? (['stub', 'Stub'].includes(value) ? 'stub' : 'native') : value
  if (destinationFor({ ...state, destination: choice.destination }).host !== 'local')
    choice.mode = 'native'
  return true
}

export function currentDirectAdd(state) {
  return state.enabled &&
    state.connected &&
    state.directAdd?.selection === addSelectionKey(state)
    ? state.directAdd
    : null
}

export function directAddPlanCurrent(state, plan) {
  return (
    currentDirectAdd(state)?.plan === plan &&
    JSON.stringify(
      prepareDirectAddSample(state, {
        agent: plan.agent,
        mode:
          plan.mode === 'Stub'
            ? 'stub'
            : plan.mode === 'Full skill'
              ? 'native'
              : plan.mode,
      }),
    ) === JSON.stringify(plan)
  )
}

export function reviewDirectAddSample(state) {
  const result = currentDirectAdd(state)
  return result &&
    !result.pending &&
    !result.success &&
    result.plan.prerequisites?.length &&
    directAddPlanCurrent(state, result.plan)
    ? result.plan
    : null
}

const completionMessage = (plan) =>
  `Added to ${plan.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${plan.destinationHost} · ${plan.destinationPath}`

export function applyReviewedDirectAddSample(state, plan) {
  if (!directAddPlanCurrent(state, plan)) return 'stale'
  const result = plan.curation
    ? applyCurationSample(state, plan)
    : applySample(state, plan)
  if (result === null || result === 'completed')
    state.directAdd = {
      ...state.directAdd,
      pending: false,
      success: true,
      message: completionMessage(plan),
    }
  return result
}

export function prepareDirectAddSample(state, options) {
  const destination = destinationFor(state)
  if (!state.enabled || !state.connected || state.directAddUncertain)
    return {
      refusal: 'This connection cannot start another Add. Check the prior result.',
    }
  if (
    !['codex', 'claude'].includes(options.agent) ||
    !['native', 'stub'].includes(options.mode)
  )
    return { refusal: 'Choose a concrete agent and Full skill or Stub.' }
  if (destination.host !== 'local' && options.mode !== 'native')
    return { refusal: 'This SSH destination supports Full skills only.' }
  let plan
  if (state.curation) {
    const source = curationSource(state)
    if (state.curation.selectedScope !== 'library' || canonicalRefusal(source))
      return {
        refusal: 'Select an accepted library version; Add does not approve content.',
      }
    if (source.projectPresent)
      return { refusal: 'Already present. Use the existing copy’s reviewed actions.' }
    plan = prepareCurationSample(state, 'add', {
      agent: options.agent,
      mode: options.mode === 'stub' ? 'Stub' : 'Full skill',
    })
    if (plan.refusal) return plan
    plan.curation = true
    plan.sourceIdentity = `${state.library.id}/synced-${source.id}`
    plan.sourceHash = source.libraryAcceptedVersion
    plan.targetPath = curationTarget(state, {
      ...source,
      projectAgent: options.agent,
      projectId: `lib-${source.id}`,
    })
  } else {
    const source = skillFor(state)
    if (!source.accepted || source.source || source.blocked)
      return {
        refusal: 'Select an accepted library version; Add does not approve content.',
      }
    const selected = { ...state, agent: options.agent }
    if (exposuresFor(selected)[source.id] || unmanagedFor(selected, source.id))
      return { refusal: 'The selected destination is occupied. Nothing was replaced.' }
    plan = previewSnapshot(selected, 'add', options.mode)
    plan.sourceIdentity = `${state.library.id}/${source.id}`
    plan.sourceHash = source.version
    plan.targetPath = targetPath(selected, source)
  }
  return {
    ...plan,
    libraryId: state.library.id,
    libraryPath: state.library.path,
    destinationHost: destination.host,
    destinationPath: destination.path,
    createOnly: true,
    prerequisites: state.samplePrerequisites || [],
  }
}

export function completeDirectAddSample(state, plan) {
  if (plan.refusal) return plan.refusal
  const current = prepareDirectAddSample(state, {
    agent: plan.agent,
    mode:
      plan.mode === 'Stub' ? 'stub' : plan.mode === 'Full skill' ? 'native' : plan.mode,
  })
  if (current.refusal || JSON.stringify(current) !== JSON.stringify(plan))
    return 'Source, destination or context changed after Add. Nothing applied; choose a new exact intent.'
  if (!plan.createOnly || plan.prerequisites.length)
    return 'Runtime prerequisites are declared but not checked. Review them explicitly before continuing.'
  if (state.sampleDirectOutcome === 'uncertain') {
    state.directAddUncertain = plan
    return 'Completion is uncertain. Inspect the original project in Files; presence alone cannot prove completion. No automatic retry.'
  }
  const result = plan.curation
    ? applyCurationSample(state, plan)
    : applySample(state, plan)
  return result === 'completed' || result === null ? null : result
}

export function createDirectAddController(current, render, notify) {
  let timer,
    generation = 0
  function revoke(clearDraft = true) {
    generation++
    globalThis.clearTimeout(timer)
    const state = current()
    state.directAdd = null
    if (clearDraft) state.addChoice = null
  }
  function start(options) {
    revoke(false)
    const state = current(),
      request = generation
    const plan = prepareDirectAddSample(state, options)
    const selection = addSelectionKey(state)
    state.directAdd = {
      selection,
      pending: !plan.refusal,
      message:
        plan.refusal ||
        `Preparing exact create-only Add: ${plan.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${['stub', 'Stub'].includes(plan.mode) ? 'Stub' : 'Full skill'} · ${plan.destinationHost} · ${plan.destinationPath}…`,
      plan,
    }
    render()
    if (plan.refusal) return
    timer = globalThis.setTimeout(() => {
      if (
        request !== generation ||
        current() !== state ||
        selection !== addSelectionKey(state)
      )
        return
      const error = completeDirectAddSample(state, plan)
      if (!state.enabled || !state.connected || current() !== state) return
      state.directAdd = {
        selection,
        pending: false,
        message: error || completionMessage(plan),
        plan,
        success: !error,
      }
      if (!error) notify(state.directAdd.message)
      render()
    }, state.sampleDirectDelay ?? 200)
  }
  return { start, revoke }
}
