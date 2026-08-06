import { localPath } from '../../shared'
import type { ProjectHost } from './project-host'

export interface SshIdentityLease {
  readonly path: string
  readonly privateKey: Buffer
  release(): void
}

export interface SshIdentitySource {
  readonly candidatePaths: readonly string[]
  acquire(path: string, signal: AbortSignal): Promise<SshIdentityLease | undefined>
}

/** Reads current local identity material and owns every mutable buffer until release. */
export class LocalSshIdentitySource implements SshIdentitySource {
  readonly candidatePaths: readonly string[]
  private readonly candidates: ReadonlySet<string>
  private readonly activeLeases = new Set<OwnedSshIdentityLease>()

  constructor(
    private readonly local: Pick<ProjectHost, 'readFile'>,
    candidatePaths: readonly string[],
  ) {
    this.candidatePaths = [...candidatePaths]
    this.candidates = new Set(candidatePaths)
  }

  get activeLeaseCount(): number {
    return this.activeLeases.size
  }

  async acquire(
    path: string,
    signal: AbortSignal,
  ): Promise<SshIdentityLease | undefined> {
    if (signal.aborted || !this.candidates.has(path)) return undefined
    let privateKey: Buffer
    try {
      privateKey = await this.local.readFile(localPath(path))
    } catch {
      return undefined
    }
    if (signal.aborted) {
      privateKey.fill(0)
      return undefined
    }
    const lease = new OwnedSshIdentityLease(path, privateKey, () => {
      this.activeLeases.delete(lease)
    })
    this.activeLeases.add(lease)
    return lease
  }
}

/** Owns the leases acquired for one physical transport's authentication generation. */
export class SshIdentityGeneration {
  private readonly attempted = new Set<string>()
  private readonly leases = new Set<SshIdentityLease>()
  private readonly abort = new AbortController()
  private active = true

  constructor(private readonly source?: SshIdentitySource) {}

  async next(): Promise<SshIdentityLease | undefined> {
    if (!this.active || !this.source) return undefined
    for (const path of this.source.candidatePaths) {
      if (this.attempted.has(path)) continue
      this.attempted.add(path)
      const lease = await this.source.acquire(path, this.abort.signal)
      if (!lease) continue
      if (!this.active) {
        lease.release()
        return undefined
      }
      this.leases.add(lease)
      return lease
    }
    return undefined
  }

  release(): void {
    if (!this.active) return
    this.active = false
    this.abort.abort()
    for (const lease of this.leases) lease.release()
    this.leases.clear()
  }
}

class OwnedSshIdentityLease implements SshIdentityLease {
  private value: Buffer | undefined
  private released = false

  constructor(
    readonly path: string,
    privateKey: Buffer,
    private readonly onRelease: () => void,
  ) {
    this.value = privateKey
  }

  get privateKey(): Buffer {
    if (!this.value) throw new Error('SSH identity lease is released')
    return this.value
  }

  release(): void {
    if (this.released) return
    this.released = true
    const value = this.value
    this.value = undefined
    value?.fill(0)
    this.onRelease()
  }
}
