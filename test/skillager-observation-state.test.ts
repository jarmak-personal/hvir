import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { SkillagerMetadataResult } from '../src/shared/skillager'
import {
  retainSkillagerObservation,
  skillagerObservationFreshness,
  type SkillagerObservationRead,
} from '../src/renderer/src/skillager/skillager-model'

it('retains source and copy observations independently, including authoritative empty and initial unknown', () => {
  const initial: SkillagerObservationRead = { loading: false }
  const complete: SkillagerMetadataResult = {
    rows: [],
    exposures: [
      {
        id: 'lib-demo',
        agent: 'codex',
        mode: 'native',
        status: 'current',
        target: localPath('/project/.agents/skills/lib-demo'),
      },
    ],
    checkedAt: 100,
    durationMs: 1,
  }
  const success = retainSkillagerObservation({ ok: true, value: complete })(initial)
  const partial: SkillagerMetadataResult = {
    ...complete,
    exposures: undefined,
    checkedAt: 200,
  }
  const retained = retainSkillagerObservation({ ok: true, value: partial })(success)
  expect(retained.observed).toBe(partial)
  expect(retained.observedExposures).toBe(success.observedExposures)
  expect(retained.observedExposures?.checkedAt).toBe(100)
  const failed = retainSkillagerObservation({
    ok: false,
    reason: 'unavailable',
    message: 'Read failed',
  })(retained)
  expect(failed.observed).toBe(partial)
  expect(failed.observedExposures).toBe(success.observedExposures)
  const empty: SkillagerMetadataResult = { ...complete, exposures: [], checkedAt: 300 }
  const recovered = retainSkillagerObservation({ ok: true, value: empty })(failed)
  expect(recovered.observed).toBe(empty)
  expect(recovered.observedExposures?.exposures).toEqual([])
  expect(recovered.observedExposures?.checkedAt).toBe(300)
  expect(
    retainSkillagerObservation({ ok: true, value: partial })(initial).observedExposures,
  ).toBeUndefined()
  expect(initial).toEqual({ loading: false })
})

it('derives both freshness values from only the owning demand and latest attempt', () => {
  const complete: SkillagerMetadataResult = {
    rows: [],
    exposures: [],
    checkedAt: 100,
    durationMs: 1,
  }
  const success = retainSkillagerObservation({ ok: true, value: complete })({
    loading: true,
  })
  expect(skillagerObservationFreshness(true, success)).toEqual({
    freshness: 'fresh',
    exposureFreshness: 'fresh',
  })
  expect(skillagerObservationFreshness(false, success)).toEqual({
    freshness: 'stale',
    exposureFreshness: 'stale',
  })
  expect(skillagerObservationFreshness(true, { ...success, loading: true })).toEqual({
    freshness: 'checking',
    exposureFreshness: 'checking',
  })
  const partial = retainSkillagerObservation<SkillagerMetadataResult>({
    ok: true,
    value: { ...complete, exposures: undefined },
  })(success)
  expect(skillagerObservationFreshness(true, partial)).toEqual({
    freshness: 'fresh',
    exposureFreshness: 'unavailable',
  })
  const failed = retainSkillagerObservation({
    ok: false,
    reason: 'unavailable',
    message: 'Read failed',
  })(success)
  expect(skillagerObservationFreshness(true, failed)).toEqual({
    freshness: 'unavailable',
    exposureFreshness: 'unavailable',
  })
  expect(skillagerObservationFreshness(true, { loading: false })).toEqual({
    freshness: 'unavailable',
    exposureFreshness: 'unavailable',
  })
})
