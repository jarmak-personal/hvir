// Closed create-only illustration; production uses its existing CLI/SSH token owner.
import {
  previewSnapshot,
  applySample,
  skillFor,
  destinationFor,
  exposuresFor,
  unmanagedFor,
} from './model.mjs'
import {
  prepareCurationSample,
  applyCurationSample,
  curationSource,
  canonicalRefusal,
} from './curation-model.mjs'

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
    state.directAddUncertain = true
    return 'Completion is uncertain. No automatic retry; refresh cannot establish this write’s outcome.'
  }
  const result = plan.curation
    ? applyCurationSample(state, plan)
    : applySample(state, plan)
  return result === 'completed' || result === null ? null : result
}

export function createDirectAddController(current, render, notify) {
  let timer,
    generation = 0
  function revoke() {
    generation++
    globalThis.clearTimeout(timer)
    const state = current()
    if (state.directAdd?.pending) state.directAdd = null
  }
  function start(options) {
    revoke()
    const state = current(),
      request = generation
    const plan = prepareDirectAddSample(state, options)
    state.directAdd = {
      pending: !plan.refusal,
      message: plan.refusal || 'Preparing exact create-only Add…',
      plan,
    }
    render()
    if (plan.refusal) return
    timer = globalThis.setTimeout(() => {
      if (request !== generation || current() !== state) return
      const error = completeDirectAddSample(state, plan)
      if (!state.enabled || !state.connected || current() !== state) return
      state.directAdd = {
        pending: false,
        message:
          error ||
          `Added to ${plan.agent === 'claude' ? 'Claude Code' : 'Codex'} · ${plan.destinationHost} · ${plan.destinationPath}`,
        plan,
        success: !error,
      }
      if (!error) notify(state.directAdd.message)
      render()
    }, state.sampleDirectDelay ?? 200)
  }
  return { start, revoke }
}
