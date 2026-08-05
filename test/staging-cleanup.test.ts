import { describe, expect, it, vi } from 'vitest'

import { ProjectFileStagingCleanup } from '../src/main/project-file-operations'
import type { ProjectHost } from '../src/main/project-host'
import { localPath, type HostConnectionState } from '../src/shared'

describe('ProjectFileStagingCleanup', () => {
  it('bounds retained and reserved staging ownership per host', async () => {
    const cleanup = new ProjectFileStagingCleanup()
    const host = new CleanupHost()
    const reservations = Array.from({ length: 256 }, () =>
      cleanup.reserve(host as unknown as ProjectHost),
    )

    expect(reservations.every(Boolean)).toBe(true)
    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeUndefined()
    reservations[0]?.release()
    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeDefined()

    for (const reservation of reservations) reservation?.release()
    await cleanup.dispose()
  })

  it('retains an exact failed cleanup and releases its observer after reconnect drain', async () => {
    const host = new CleanupHost()
    const cleanup = new ProjectFileStagingCleanup()
    const path = localPath('/project/.hvir-import-owned')
    host.entries.add(path.path)
    host.state = 'disconnected'

    await expect(
      cleanup.cleanup(host as unknown as ProjectHost, path),
    ).resolves.toBeUndefined()
    expect(host.listenerCount).toBe(1)
    expect(host.entries.has(path.path)).toBe(true)

    host.setState('connected')
    await vi.waitFor(() => expect(host.entries.has(path.path)).toBe(false))
    await vi.waitFor(() => expect(host.listenerCount).toBe(0))

    await cleanup.dispose()
  })

  it('refuses cleanup authority for non-staging paths', async () => {
    const cleanup = new ProjectFileStagingCleanup()
    const host = new CleanupHost()

    await expect(
      cleanup.cleanup(host as unknown as ProjectHost, localPath('/project/real.txt')),
    ).rejects.toThrow('Refusing cleanup')
    await cleanup.dispose()
  })
})

class CleanupHost {
  readonly hostId = localPath('/').hostId
  state: HostConnectionState = 'connected'
  readonly entries = new Set<string>()
  private readonly listeners = new Set<(state: HostConnectionState) => void>()
  readonly fileTransfer = {
    removeDirectory: vi.fn(),
  }

  get connectionState(): HostConnectionState {
    return this.state
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  onConnectionState(listener: (state: HostConnectionState) => void) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  setState(state: HostConnectionState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener(state)
  }

  stat(path: ReturnType<typeof localPath>) {
    if (this.state !== 'connected') return Promise.reject(new Error('disconnected'))
    if (!this.entries.has(path.path)) {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    return Promise.resolve({ type: 'file', size: 1, mtimeMs: 1, mode: 0o100644 })
  }

  removeFile(path: ReturnType<typeof localPath>) {
    this.entries.delete(path.path)
    return Promise.resolve()
  }
}
