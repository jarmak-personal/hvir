import { describe, expect, it } from 'vitest'

import { planKindLabels } from '../scripts/project-management/kind-policy.ts'

describe('project kind policy', () => {
  it('accepts exactly one recognized kind', () => {
    expect(
      planKindLabels(['area:terminal', 'kind:feature'], { action: 'reconcile' }),
    ).toMatchObject({
      state: 'valid',
      kind: { label: 'kind:feature', option: 'Feature' },
      labelsToAdd: [],
      labelsToRemove: [],
    })
  })

  it('lets a newly applied kind replace every competing scoped label', () => {
    expect(
      planKindLabels(['kind:bug', 'kind:future', 'kind:enhancement'], {
        action: 'labeled',
        label: 'kind:enhancement',
      }),
    ).toMatchObject({
      state: 'valid',
      kind: { label: 'kind:enhancement' },
      labelsToRemove: ['kind:bug', 'kind:future'],
      ignoredEvent: false,
    })
  })

  it('ignores a delayed labeled event after its label is no longer present', () => {
    expect(
      planKindLabels(['kind:bug'], { action: 'labeled', label: 'kind:feature' }),
    ).toMatchObject({
      state: 'valid',
      kind: { label: 'kind:bug' },
      labelsToRemove: [],
      ignoredEvent: true,
    })
  })

  it('restores a removed sole kind', () => {
    expect(planKindLabels([], { action: 'unlabeled', label: 'kind:docs' })).toMatchObject(
      {
        state: 'valid',
        kind: { label: 'kind:docs' },
        labelsToAdd: ['kind:docs'],
      },
    )
  })

  it('does not restore an old kind when its replacement is present', () => {
    expect(
      planKindLabels(['kind:feature'], { action: 'unlabeled', label: 'kind:bug' }),
    ).toMatchObject({
      state: 'valid',
      kind: { label: 'kind:feature' },
      labelsToAdd: [],
    })
  })

  it('reports missing and ambiguous kinds without guessing', () => {
    expect(planKindLabels(['area:harness'], { action: 'reconcile' })).toMatchObject({
      state: 'missing',
    })
    expect(
      planKindLabels(['kind:bug', 'kind:feature'], { action: 'reconcile' }),
    ).toMatchObject({ state: 'ambiguous', labelsToAdd: [], labelsToRemove: [] })
    expect(planKindLabels(['kind:future'], { action: 'reconcile' })).toMatchObject({
      state: 'ambiguous',
    })
  })
})
