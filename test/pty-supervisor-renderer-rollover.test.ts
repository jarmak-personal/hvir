import { describe, expect, it, vi } from 'vitest'

import {
  createPtySupervisorFixture,
  plainShellProvider,
  PTY_FIXTURE_OWNER_ID,
} from './fixtures/pty-supervisor-fixture'

const OWNER_ID = PTY_FIXTURE_OWNER_ID

async function fixture() {
  const ptyFixture = createPtySupervisorFixture({ provider: plainShellProvider })
  const info = await ptyFixture.spawn({
    provider: plainShellProvider,
    ownerId: OWNER_ID,
    ownerGeneration: 4,
    sessionId: 'renderer-rollover',
  })
  return { info, pty: ptyFixture.pty, supervisor: ptyFixture.supervisor }
}

describe('PtySupervisor renderer rollover', () => {
  it('transfers an attached PTY across generations with bounded replay', async () => {
    const { info, pty, supervisor } = await fixture()
    const staleData = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: staleData }, 4)
    pty.emitData('before rollover')

    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      true,
    )
    expect(supervisor.isAwaitingRendererAttachment(info.id, OWNER_ID, 5)).toBe(true)
    expect(supervisor.get(info.id)).toMatchObject({
      pid: info.pid,
      ownerId: OWNER_ID,
      ownerGeneration: 5,
    })
    expect(pty.kill).not.toHaveBeenCalled()
    expect(() => supervisor.write(info.id, OWNER_ID, 'stale', 4)).toThrow(
      /another renderer/,
    )

    pty.emitData('during rollover')
    expect(staleData).toHaveBeenCalledTimes(1)
    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 5, OWNER_ID, 6)).toBe(
      true,
    )
    expect(supervisor.isAwaitingRendererAttachment(info.id, OWNER_ID, 6)).toBe(true)
    const currentData = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: currentData }, 6)
    expect(currentData).toHaveBeenCalledWith('during rollover')
    expect(supervisor.isAwaitingRendererAttachment(info.id, OWNER_ID, 6)).toBe(false)

    supervisor.write(info.id, OWNER_ID, 'current', 6)
    supervisor.resize(info.id, OWNER_ID, 120, 40, 6)
    expect(pty.write).toHaveBeenCalledWith('current')
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
  })

  it('does not transfer a PTY before its renderer stream is attached', async () => {
    const { info, pty, supervisor } = await fixture()

    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      false,
    )
    expect(supervisor.isAwaitingRendererAttachment(info.id, OWNER_ID, 4)).toBe(false)
    expect(supervisor.get(info.id)?.ownerGeneration).toBe(4)
    expect(pty.kill).not.toHaveBeenCalled()
  })
})
