import { describe, expect, it, vi } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import type { ProjectHost, PtyExit, PtyProcess } from '../src/main/project-host'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { LOCAL_HOST_ID, localPath } from '../src/shared'

const OWNER_ID = 17

class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly dataListeners = new Set<(data: string) => void>()
  readonly exitListeners = new Set<(exit: PtyExit) => void>()
  readonly write = vi.fn<(data: string) => void>()
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<(signal?: string) => void>()

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (exit: PtyExit) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  emitData(data: string): void {
    for (const cb of this.dataListeners) cb(data)
  }
}

async function fixture() {
  const pty = new FakePty()
  const host = {
    hostId: LOCAL_HOST_ID,
    defaultShell: () => Promise.resolve('/bin/sh'),
    spawnPty: () => Promise.resolve(pty),
  } as unknown as ProjectHost
  const supervisor = new PtySupervisor()
  const info = await supervisor.spawn({
    host,
    provider: plainShellProvider,
    cwd: localPath('/tmp/project'),
    ownerId: OWNER_ID,
    ownerGeneration: 4,
    sessionId: 'renderer-rollover',
  })
  return { info, pty, supervisor }
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
    const currentData = vi.fn<(data: string) => void>()
    supervisor.attach(info.id, OWNER_ID, { onData: currentData }, 5)
    expect(currentData).toHaveBeenCalledWith('during rollover')

    supervisor.write(info.id, OWNER_ID, 'current', 5)
    supervisor.resize(info.id, OWNER_ID, 120, 40, 5)
    expect(pty.write).toHaveBeenCalledWith('current')
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
  })

  it('does not transfer a PTY before its renderer stream is attached', async () => {
    const { info, pty, supervisor } = await fixture()

    expect(supervisor.transferRendererSession(info.id, OWNER_ID, 4, OWNER_ID, 5)).toBe(
      false,
    )
    expect(supervisor.get(info.id)?.ownerGeneration).toBe(4)
    expect(pty.kill).not.toHaveBeenCalled()
  })
})
