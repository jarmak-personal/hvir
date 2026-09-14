import { expect, it, vi } from 'vitest'
import { skillagerLibrarySyncFixture } from '../src/main/smoke/skillager-library-sync-fixture'
import { syncContext, syncSelection } from './fixtures/skillager-sync-fixture'

const selection = {
  ...syncSelection,
  library: { ...syncSelection.library, id: 'onboarding-library' },
}

it('holds actual submitted apply until its scenario releases completion', async () => {
  const fixture = skillagerLibrarySyncFixture(),
    held = fixture.holdNextApply(),
    controller = new AbortController(),
    submitted = vi.fn()
  try {
    const pending = fixture.cli.syncApproved(
      selection,
      syncContext,
      controller.signal,
      submitted,
    )
    expect(await held.submitted).toBe(true)
    expect(submitted).toHaveBeenCalledOnce()
    let completed = false
    void pending.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(fixture.synced).toBe(false)
    held.release()
    expect((await pending).counts.created).toBe(1)
    expect(fixture.synced).toBe(true)
  } finally {
    controller.abort()
    held.release()
  }
})

it('abort settles a held apply without publishing even if the scenario releases later', async () => {
  const fixture = skillagerLibrarySyncFixture(),
    held = fixture.holdNextApply(),
    controller = new AbortController()
  try {
    const pending = fixture.cli.syncApproved(
      selection,
      syncContext,
      controller.signal,
      () => undefined,
    )
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    expect(await held.submitted).toBe(true)
    controller.abort()
    await rejected
    held.release()
    expect(fixture.synced).toBe(false)
  } finally {
    controller.abort()
    held.release()
  }
})

it('releasing an abandoned hold cannot release a subsequently submitted apply', async () => {
  const fixture = skillagerLibrarySyncFixture(),
    abandoned = fixture.holdNextApply()
  abandoned.release()
  expect(await abandoned.submitted).toBe(false)
  const held = fixture.holdNextApply(),
    controller = new AbortController()
  try {
    const pending = fixture.cli.syncApproved(
      selection,
      syncContext,
      controller.signal,
      () => undefined,
    )
    expect(await held.submitted).toBe(true)
    let completed = false
    void pending.then(() => {
      completed = true
    })
    abandoned.release()
    await Promise.resolve()
    expect(completed).toBe(false)
    held.release()
    expect((await pending).counts.created).toBe(1)
  } finally {
    controller.abort()
    held.release()
  }
})
