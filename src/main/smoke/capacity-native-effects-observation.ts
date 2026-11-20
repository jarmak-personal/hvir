import type {
  NativeTerminalEffectObservation,
  NativeTerminalEffectPolicy,
} from '../terminal/native-terminal-effect-policy'

const EPOCH_MS = 50
const MAX_EPOCHS = 128
const MAX_INSTANCES = 32

interface EffectCounts {
  batches: number
  effects: number
  semanticEffects: number
  screenEffects: number
  executionFailures: number
  firstObservedDroppedEffects: number
  droppedEffectsAdvance: number
  firstObservedSemanticGeneration: number
  semanticGenerationAdvance: number
  counterRegressions: number
  untrackedCounterBatches: number
}

function counts(): EffectCounts {
  return {
    batches: 0,
    effects: 0,
    semanticEffects: 0,
    screenEffects: 0,
    executionFailures: 0,
    firstObservedDroppedEffects: 0,
    droppedEffectsAdvance: 0,
    firstObservedSemanticGeneration: 0,
    semanticGenerationAdvance: 0,
    counterRegressions: 0,
    untrackedCounterBatches: 0,
  }
}

/** Copied batch facts after main policy consumption, never renderer-delivery evidence. */
export function observeCapacityNativeEffects(
  effects: Pick<NativeTerminalEffectPolicy, 'observe'>,
  now: () => number = Date.now,
) {
  const startedAtMs = now()
  const totals = counts()
  const epochs = new Map<number, EffectCounts>()
  const instances = new Map<string, { dropped: number; generation: number }>()
  let stoppedAtMs: number | undefined
  let omittedEpochBatches = 0
  const stopObservation = effects.observe(
    (observation: NativeTerminalEffectObservation) => {
      if (stoppedAtMs !== undefined) return
      const epoch = Math.max(0, Math.floor((now() - startedAtMs) / EPOCH_MS))
      let bucket = epochs.get(epoch)
      if (!bucket && epochs.size < MAX_EPOCHS) {
        bucket = counts()
        epochs.set(epoch, bucket)
      }
      if (!bucket) omittedEpochBatches++
      const delta = counts()
      delta.batches = 1
      delta.effects = observation.batch.effects.length
      for (const effect of observation.batch.effects) {
        if (effect.kind === 'semantic') delta.semanticEffects++
        else if (effect.kind === 'screen') delta.screenEffects++
      }
      delta.executionFailures = observation.executionFailures
      const previous = instances.get(observation.session.instanceId)
      const dropped = observation.batch.droppedEffects
      const generation = observation.batch.semanticGeneration
      if (previous) {
        delta.droppedEffectsAdvance = Math.max(0, dropped - previous.dropped)
        delta.semanticGenerationAdvance = Math.max(0, generation - previous.generation)
        delta.counterRegressions = Number(
          dropped < previous.dropped || generation < previous.generation,
        )
        previous.dropped = dropped
        previous.generation = generation
      } else if (instances.size < MAX_INSTANCES) {
        instances.set(observation.session.instanceId, { dropped, generation })
        delta.firstObservedDroppedEffects = dropped
        delta.firstObservedSemanticGeneration = generation
      } else delta.untrackedCounterBatches = 1
      for (const key of Object.keys(delta) as Array<keyof EffectCounts>) {
        totals[key] += delta[key]
        if (bucket) bucket[key] += delta[key]
      }
    },
  )
  return {
    stop() {
      if (stoppedAtMs === undefined) {
        stoppedAtMs = now()
        stopObservation()
        instances.clear()
      }
      return {
        clock: 'Date.now' as const,
        observationOwner: 'main-effect-policy-after-consume' as const,
        rendererDeliveryQualified: false as const,
        startedAtMs,
        stoppedAtMs,
        epochMs: EPOCH_MS,
        maximumEpochs: MAX_EPOCHS,
        maximumTrackedInstances: MAX_INSTANCES,
        omittedEpochBatches,
        counterBaseline: 'first-observation-not-window-start' as const,
        totals: { ...totals },
        epochs: [...epochs].map(([epoch, value]) => ({
          startedAtMs: startedAtMs + epoch * EPOCH_MS,
          ...value,
        })),
      }
    },
  }
}
