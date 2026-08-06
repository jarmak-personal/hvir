import { describe, expect, it, vi } from 'vitest'

import { ProjectFileStagingCleanup } from '../src/main/project-file-operations'
import type { ProjectHost } from '../src/main/project-host'
import { localPath, type HostConnectionState } from '../src/shared'

describe('ProjectFileStagingCleanup', () => {
  it('bounds retained and reserved staging ownership per host', async () => {
    const cleanup = new ProjectFileStagingCleanup()
    const host = new CleanupHost()
    const reservation = cleanup.reserve(host as unknown as ProjectHost, 256)
    if (!reservation) throw new Error('Expected staging capacity')

    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeUndefined()
    reservation.release()
    expect(cleanup.reserve(host as unknown as ProjectHost, 256)).toBeDefined()

    await cleanup.dispose()
  })

  it('admits a multi-item batch only when its complete cleanup capacity fits', async () => {
    const cleanup = new ProjectFileStagingCleanup()
    const host = new CleanupHost()
    const held = cleanup.reserve(host as unknown as ProjectHost, 255)
    if (!held) throw new Error('Expected staging capacity')

    expect(cleanup.reserve(host as unknown as ProjectHost, 2)).toBeUndefined()
    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeDefined()
    held.release()
    await cleanup.dispose()
  })

  it('converts failed cleanup into exact debt and releases unused batch slots', async () => {
    const host = new CleanupHost()
    const cleanup = new ProjectFileStagingCleanup()
    const reservation = cleanup.reserve(host as unknown as ProjectHost, 3)
    if (!reservation) throw new Error('Expected staging capacity')
    const path = localPath('/project/.hvir-import-owned')
    host.entries.add(path.path)
    host.state = 'disconnected'

    await expect(reservation.cleanup(path)).resolves.toBeUndefined()
    reservation.release()
    expect(host.listenerCount).toBe(1)
    expect(host.entries.has(path.path)).toBe(true)
    const remainingCapacity = cleanup.reserve(host as unknown as ProjectHost, 255)
    expect(remainingCapacity).toBeDefined()
    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeUndefined()
    remainingCapacity?.release()

    host.setState('connected')
    await vi.waitFor(() => expect(host.entries.has(path.path)).toBe(false))
    await vi.waitFor(() => expect(host.listenerCount).toBe(0))
    expect(cleanup.reserve(host as unknown as ProjectHost, 256)).toBeDefined()

    await cleanup.dispose()
  })

  it('retains and drains every exact path from a maximum-size failed batch', async () => {
    const host = new CleanupHost()
    const cleanup = new ProjectFileStagingCleanup()
    const reservation = cleanup.reserve(host as unknown as ProjectHost, 256)
    if (!reservation) throw new Error('Expected staging capacity')
    const paths = Array.from({ length: 256 }, (_, index) =>
      localPath(`/project/.hvir-import-batch-${index}`),
    )
    paths.forEach((path) => host.entries.add(path.path))
    host.state = 'disconnected'

    await Promise.all(paths.map((path) => reservation.cleanup(path)))
    reservation.release()
    expect(cleanup.reserve(host as unknown as ProjectHost)).toBeUndefined()
    expect(host.entries.size).toBe(256)

    host.setState('connected')
    await vi.waitFor(() => expect(host.entries.size).toBe(0))
    await vi.waitFor(() => expect(host.listenerCount).toBe(0))
    expect(cleanup.reserve(host as unknown as ProjectHost, 256)).toBeDefined()

    await cleanup.dispose()
  })

  it('refuses cleanup authority for non-staging paths', async () => {
    const cleanup = new ProjectFileStagingCleanup()
    const host = new CleanupHost()
    const reservation = cleanup.reserve(host as unknown as ProjectHost)
    if (!reservation) throw new Error('Expected staging capacity')

    await expect(reservation.cleanup(localPath('/project/real.txt'))).rejects.toThrow(
      'Refusing cleanup',
    )
    reservation.release()
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
