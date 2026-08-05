import { basenameHostPath, joinHostPath, type HostPath, type Stat } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'

const MAX_RETAINED_STAGING_PATHS_PER_HOST = 256

interface PendingCleanup {
  readonly host: ProjectHost
  readonly path: HostPath
}

/** Exact hidden-staging cleanup with bounded reconnect retention. */
export class ProjectFileStagingCleanup {
  private readonly pending = new Map<string, PendingCleanup>()
  private readonly stopConnection = new Map<string, Disposer>()
  private readonly drains = new Map<string, Promise<void>>()
  private readonly reservations = new Map<string, number>()
  private disposed = false

  reserve(host: ProjectHost): { release(): void } | undefined {
    const retained = this.retainedForHost(host.hostId)
    const reserved = this.reservations.get(host.hostId) ?? 0
    if (retained + reserved >= MAX_RETAINED_STAGING_PATHS_PER_HOST) return undefined
    this.reservations.set(host.hostId, reserved + 1)
    let active = true
    return {
      release: () => {
        if (!active) return
        active = false
        const remaining = (this.reservations.get(host.hostId) ?? 1) - 1
        if (remaining > 0) this.reservations.set(host.hostId, remaining)
        else this.reservations.delete(host.hostId)
      },
    }
  }

  async cleanup(host: ProjectHost, path: HostPath): Promise<void> {
    assertStagingPath(host, path)
    try {
      await removeExactStagingTree(host, path)
      this.pending.delete(pathKey(path))
    } catch {
      if (this.disposed) return
      this.pending.set(pathKey(path), { host, path })
      this.observe(host)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.allSettled(
      [...this.pending.values()]
        .filter(({ host }) => host.connectionState === 'connected')
        .map(({ host, path }) => removeExactStagingTree(host, path)),
    )
    for (const stop of this.stopConnection.values()) await stop()
    this.stopConnection.clear()
    this.pending.clear()
    this.reservations.clear()
  }

  private observe(host: ProjectHost): void {
    if (this.stopConnection.has(host.hostId)) return
    const stop = host.onConnectionState((state) => {
      if (state === 'connected') queueMicrotask(() => this.scheduleDrain(host))
    })
    this.stopConnection.set(host.hostId, stop)
  }

  private scheduleDrain(host: ProjectHost): void {
    if (this.disposed || this.drains.has(host.hostId)) return
    const drain = this.drain(host).finally(() => this.drains.delete(host.hostId))
    this.drains.set(host.hostId, drain)
  }

  private async drain(host: ProjectHost): Promise<void> {
    for (const cleanup of [...this.pending.values()]) {
      if (cleanup.host !== host || host.connectionState !== 'connected') continue
      try {
        await removeExactStagingTree(host, cleanup.path)
        this.pending.delete(pathKey(cleanup.path))
      } catch {
        return
      }
    }
    if (this.retainedForHost(host.hostId) === 0) {
      const stop = this.stopConnection.get(host.hostId)
      this.stopConnection.delete(host.hostId)
      await stop?.()
    }
  }

  private retainedForHost(hostId: string): number {
    return [...this.pending.values()].filter(({ host }) => host.hostId === hostId).length
  }
}

export async function removeExactStagingTree(
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  assertStagingPath(host, root)
  await removeTree(host, root)
}

async function removeTree(host: ProjectHost, root: HostPath): Promise<void> {
  let stat: Stat
  try {
    stat = await host.stat(root)
  } catch (reason) {
    if (isMissingPathError(reason)) return
    throw reason
  }
  if (stat.type === 'dir') {
    for (const entry of await host.readdir(root)) {
      await removeTree(host, joinHostPath(root, entry.name))
    }
    await requireTransfer(host).removeDirectory(root, { ignoreMissing: true })
  } else {
    await host.removeFile(root, { ignoreMissing: true })
  }
}

function assertStagingPath(host: ProjectHost, path: HostPath): void {
  if (
    path.hostId !== host.hostId ||
    !basenameHostPath(path).startsWith('.hvir-import-')
  ) {
    throw new Error('Refusing cleanup outside an exact hvir import staging path')
  }
}

function requireTransfer(host: ProjectHost) {
  if (!host.fileTransfer) throw new Error('This project host cannot clean staging paths')
  return host.fileTransfer
}

function isMissingPathError(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  return (
    code === 'ENOENT' ||
    code === 2 ||
    /no such file|not found/i.test(reason instanceof Error ? reason.message : '')
  )
}

function pathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}
