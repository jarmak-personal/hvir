import { describe, expect, it } from 'vitest'
import { observeCapacityNativeEffects } from '../src/main/smoke/capacity-native-effects-observation'
import { NativeTerminalEffectPolicy } from '../src/main/terminal/native-terminal-effect-policy'
import { asHostId, hostPath } from '../src/shared/host-path'
import type { NativeTerminalEffect } from '../src/shared/native-terminal-effects'

const session = (instanceId: string) => ({
  sessionId: 'private-session',
  instanceId,
  ownerId: 1,
  ownerGeneration: 2,
  workspaceRoot: hostPath(asHostId('local'), '/private-project'),
})
const semantic: NativeTerminalEffect = {
  kind: 'semantic',
  action: 0,
  options: 'private-options',
  screen: 'normal',
  row: 0,
  column: 0,
  sequence: 1,
  eventSerial: 1,
}
const authority = { current: () => true, live: () => true }

describe('capacity native effect observations', () => {
  it('aggregates actual consumed batches and cumulative counter deltas without contents', () => {
    let now = 1000
    const policy = new NativeTerminalEffectPolicy({ writeText() {} }, () => undefined)
    const observation = observeCapacityNativeEffects(policy, () => now)
    const consume = (instance: string, dropped: number, generation: number) =>
      policy.consume(
        session(instance),
        {
          effects: [
            semantic,
            {
              kind: 'screen',
              action: 'clear',
              screen: 'normal',
              sequence: 1,
              eventSerial: 2,
            },
          ],
          droppedEffects: dropped,
          semanticGeneration: generation,
        },
        authority,
      )
    consume('private-instance-a', 7, 2)
    now = 1049
    consume('private-instance-a', 7, 2)
    now = 1050
    consume('private-instance-a', 10, 4)
    consume('private-instance-b', 5, 1)
    const report = observation.stop()
    expect(report.totals).toMatchObject({
      batches: 4,
      effects: 8,
      semanticEffects: 4,
      screenEffects: 4,
      firstObservedDroppedEffects: 12,
      droppedEffectsAdvance: 3,
      firstObservedSemanticGeneration: 3,
      semanticGenerationAdvance: 2,
    })
    expect(report.epochs.map((epoch) => [epoch.startedAtMs, epoch.batches])).toEqual([
      [1000, 2],
      [1050, 2],
    ])
    expect(report.rendererDeliveryQualified).toBe(false)
    expect(JSON.stringify(report)).not.toMatch(/private-/)
    now = 2000
    consume('private-instance-a', 30, 30)
    expect(observation.stop()).toEqual(report)
  })

  it('retains total counts after bounded epochs and explicitly marks untracked counters', () => {
    let now = 0
    const policy = new NativeTerminalEffectPolicy({ writeText() {} }, () => undefined)
    const observation = observeCapacityNativeEffects(policy, () => now)
    for (let i = 0; i < 140; i++) {
      now = i * 50
      policy.consume(
        session(`instance-${i}`),
        { effects: [semantic], droppedEffects: i, semanticGeneration: i },
        authority,
      )
    }
    const report = observation.stop()
    expect(report.epochs).toHaveLength(128)
    expect(report.omittedEpochBatches).toBe(12)
    expect(report.totals).toMatchObject({
      batches: 140,
      semanticEffects: 140,
      untrackedCounterBatches: 108,
    })
  })

  it('reports counter regression and observed execution failure without changing consumption', () => {
    const policy = new NativeTerminalEffectPolicy({ writeText() {} }, () => {
      throw new Error('private-error')
    })
    const observation = observeCapacityNativeEffects(policy, () => 0)
    for (const counter of [2, 1])
      policy.consume(
        session('instance'),
        {
          effects: [
            { kind: 'title', title: 'private-title', sequence: 1, eventSerial: 1 },
          ],
          droppedEffects: counter,
          semanticGeneration: counter,
        },
        authority,
      )
    expect(observation.stop().totals).toMatchObject({
      executionFailures: 2,
      counterRegressions: 1,
      droppedEffectsAdvance: 0,
      semanticGenerationAdvance: 0,
    })
  })
})
