import { describe, expect, it } from 'vitest'
import { smokeOwnedResourceEvidence } from '../src/main/smoke/failure-evidence.mts'

describe('owned smoke resource evidence', () => {
  it('qualifies a live window and PTYs independently of a revoked renderer owner', () => {
    const win = { isDestroyed: () => false, webContents: { id: 42 } }
    const ptys = { list: () => [{}, {}] }
    expect(
      smokeOwnedResourceEvidence(win, ptys, true, {
        currentOwner: () => ({ generation: 3 }),
      }),
    ).toEqual({
      windowCount: 1,
      ptyCount: 2,
      watcherActive: true,
      rendererOwnerActive: true,
      rendererGeneration: 3,
    })
    expect(
      smokeOwnedResourceEvidence(win, ptys, false, {
        currentOwner: () => {
          throw new Error('revoked')
        },
      }),
    ).toEqual({
      windowCount: 1,
      ptyCount: 2,
      watcherActive: false,
      rendererOwnerActive: false,
      rendererGeneration: null,
    })
  })
  it('never inspects a destroyed native window and reports absent resources honestly', () => {
    const win = {
      isDestroyed: () => true,
      get webContents(): { id: number } {
        throw new Error('destroyed')
      },
    }
    const resources = {
      currentOwner: () => {
        throw new Error('must not inspect')
      },
    }
    const empty = {
      windowCount: 0,
      ptyCount: 0,
      watcherActive: false,
      rendererOwnerActive: false,
      rendererGeneration: null,
    }
    expect(smokeOwnedResourceEvidence(win, undefined, false, resources)).toEqual(empty)
    expect(smokeOwnedResourceEvidence(undefined, undefined, false, resources)).toEqual(
      empty,
    )
  })
})
