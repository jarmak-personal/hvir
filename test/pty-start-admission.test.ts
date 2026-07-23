import { describe, expect, it, vi } from 'vitest'

import { TerminalStartAdmission } from '../src/shared'

describe('TerminalStartAdmission', () => {
  it('bounds bulk starts per host while allowing another host independently', async () => {
    const admission = new TerminalStartAdmission(2)
    const local = new AbortController()
    const localSecond = new AbortController()
    const localThird = new AbortController()
    const ssh = new AbortController()

    const releaseFirst = await admission.acquire('local', local.signal)
    const releaseSecond = await admission.acquire('local', localSecond.signal)
    const third = vi.fn()
    const thirdAdmission = admission
      .acquire('local', localThird.signal)
      .then((release) => {
        third()
        return release
      })
    const releaseSsh = await admission.acquire('ssh:example', ssh.signal)

    await Promise.resolve()
    expect(third).not.toHaveBeenCalled()
    releaseFirst()
    const releaseThird = await thirdAdmission
    expect(third).toHaveBeenCalledOnce()

    releaseSecond()
    releaseThird()
    releaseSsh()
  })

  it('removes a cancelled queued start without blocking the next one', async () => {
    const admission = new TerminalStartAdmission(1)
    const active = new AbortController()
    const cancelled = new AbortController()
    const next = new AbortController()
    const releaseActive = await admission.acquire('ssh:example', active.signal)
    const cancelledAdmission = admission.acquire('ssh:example', cancelled.signal)
    const nextAdmission = admission.acquire('ssh:example', next.signal)

    cancelled.abort()
    await expect(cancelledAdmission).rejects.toThrow('admission was cancelled')
    releaseActive()
    const releaseNext = await nextAdmission
    releaseNext()
  })
})
