import {
  hostPath,
  hostPathEquals,
  type Disposer,
  type HostPath,
  type IpcEventPayload,
} from '../shared'
import type { ProjectHost } from './project-host'

export interface ProjectWatchTarget {
  readonly host: ProjectHost
  readonly root: HostPath
  readonly projectId: string
}

export interface ProjectWatchCallbacks {
  readonly emit: (event: IpcEventPayload<'project:watch'>) => void
  readonly refreshGit: () => void
  readonly repositoryEnabled: () => boolean
}

export type ProjectWatchInterestCache = Map<
  string,
  { readonly path: HostPath; readonly validatedAt: number }
>

export async function canonicalProjectWatchInterests(
  host: ProjectHost,
  root: HostPath,
  requestedPaths: unknown,
  limit: number,
  cache?: ProjectWatchInterestCache,
): Promise<{ readonly paths: readonly HostPath[]; readonly limited: boolean }> {
  if (!Array.isArray(requestedPaths) || requestedPaths.length > 512) {
    throw new Error('Invalid project watch interest count')
  }
  const canonical: HostPath[] = []
  for (const rawCandidate of requestedPaths) {
    const candidate: unknown = rawCandidate
    const candidateRecord =
      candidate && typeof candidate === 'object'
        ? (candidate as Record<string, unknown>)
        : undefined
    const candidateHostId = candidateRecord?.['hostId']
    const candidatePath = candidateRecord?.['path']
    if (
      typeof candidateHostId !== 'string' ||
      typeof candidatePath !== 'string' ||
      candidateHostId !== root.hostId ||
      !candidatePath.startsWith('/') ||
      !isInsideProjectPath(candidatePath, root.path)
    ) {
      throw new Error('Watch interest escapes the active workspace')
    }
    const cacheKey = `${candidateHostId}:${candidatePath}`
    const cached = cache?.get(cacheKey)
    let resolved: HostPath
    if (cached && Date.now() - cached.validatedAt < 30_000) {
      resolved = cached.path
    } else {
      resolved = await host.realpath(hostPath(root.hostId, candidatePath))
      if (!isInsideProjectPath(resolved.path, root.path)) {
        throw new Error('Canonical watch interest escapes the active workspace')
      }
      const stat = await host.stat(resolved)
      if (stat.type !== 'dir') throw new Error('Watch interests must be directories')
      if (cache) {
        if (cache.size >= 1_024) cache.clear()
        cache.set(cacheKey, { path: resolved, validatedAt: Date.now() })
      }
    }
    if (
      !hostPathEquals(resolved, root) &&
      !canonical.some((existing) => hostPathEquals(existing, resolved))
    ) {
      canonical.push(resolved)
    }
  }
  return {
    paths: canonical.slice(0, limit),
    limited: canonical.length > limit,
  }
}

/**
 * Owns the active workspace's bounded watch lifecycle. Content interests share
 * one shallow backend; noisy Git metadata remains isolated in a second shallow
 * backend so replacing tree interests does not interrupt repository updates.
 */
export class ProjectWatchController {
  private contentStop: Disposer | undefined
  private gitStop: Disposer | undefined
  private gitDiscovery: Promise<void> | undefined
  private rediscoverGit = false
  private replaceTail: Promise<void> = Promise.resolve()
  private replaceTimer: ReturnType<typeof setTimeout> | undefined
  private eventTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pendingEvents = new Map<string, IpcEventPayload<'project:watch'>>()
  private interests: readonly HostPath[] = []
  private stopped = false

  constructor(
    readonly target: ProjectWatchTarget,
    private readonly callbacks: ProjectWatchCallbacks,
  ) {
    this.contentStop = this.createContentWatch()
    this.discoverGitMetadata()
  }

  updateInterests(interests: readonly HostPath[]): void {
    if (this.stopped || samePaths(this.interests, interests)) return
    this.interests = interests
    if (this.replaceTimer) clearTimeout(this.replaceTimer)
    this.replaceTimer = setTimeout(() => {
      this.replaceTimer = undefined
      this.replaceContentWatch()
    }, 50)
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.replaceTimer) clearTimeout(this.replaceTimer)
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.replaceTimer = undefined
    this.eventTimer = undefined
    this.pendingEvents.clear()
    await this.replaceTail
    const contentStop = this.contentStop
    const gitStop = this.gitStop
    this.contentStop = undefined
    this.gitStop = undefined
    await Promise.all([
      Promise.resolve(contentStop?.()),
      Promise.resolve(gitStop?.()),
      this.gitDiscovery?.catch(() => undefined),
    ])
  }

  private createContentWatch(): Disposer {
    return this.target.host.watch(
      this.target.root,
      (event) => this.receiveContent(event),
      {
        recursive: false,
        additionalPaths: this.interests,
        onError: (error) => console.error('[watch] project watcher failed', error),
      },
    )
  }

  private replaceContentWatch(): void {
    const replace = async (): Promise<void> => {
      const previous = this.contentStop
      this.contentStop = undefined
      await previous?.()
      if (!this.stopped) this.contentStop = this.createContentWatch()
    }
    const next = this.replaceTail.then(replace, replace)
    this.replaceTail = next.catch((error) => {
      console.error('[watch] failed to replace project interests', error)
    })
  }

  private receiveContent(event: IpcEventPayload<'project:watch'>): void {
    if (this.stopped) return
    if (isRootGitEntry(this.target.root, event.path)) {
      this.callbacks.refreshGit()
      this.discoverGitMetadata()
    } else if (this.callbacks.repositoryEnabled()) {
      this.callbacks.refreshGit()
    }
    this.queueEvent(event)
  }

  private queueEvent(event: IpcEventPayload<'project:watch'>): void {
    if (this.stopped) return
    this.pendingEvents.set(`${event.path.hostId}:${event.path.path}`, event)
    if (this.eventTimer) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined
      for (const pending of this.pendingEvents.values()) this.callbacks.emit(pending)
      this.pendingEvents.clear()
    }, 100)
  }

  private discoverGitMetadata(): void {
    if (this.stopped || this.gitStop) return
    if (this.gitDiscovery) {
      this.rediscoverGit = true
      return
    }
    this.gitDiscovery = this.target.host
      .exec('git', ['-C', this.target.root.path, 'rev-parse', '--absolute-git-dir'])
      .then((result) => {
        const gitDirectory = result.code === 0 ? result.stdout.trim() : ''
        if (this.stopped || this.gitStop || !gitDirectory.startsWith('/')) return
        this.gitStop = this.target.host.watch(
          hostPath(this.target.root.hostId, gitDirectory),
          (event) => {
            this.callbacks.refreshGit()
            this.queueEvent(event)
          },
          {
            recursive: false,
            onError: (error) =>
              console.error('[watch] git metadata watcher failed', error),
          },
        )
        // Discovery can happen after switching to a formerly plain project or
        // after `git init`; reconcile repository capability immediately.
        this.callbacks.refreshGit()
      })
      .catch((error) => console.error('[watch] git metadata discovery failed', error))
      .finally(() => {
        this.gitDiscovery = undefined
        if (this.rediscoverGit) {
          this.rediscoverGit = false
          this.discoverGitMetadata()
        }
      })
  }
}

function samePaths(left: readonly HostPath[], right: readonly HostPath[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (candidate, index) =>
        candidate.hostId === right[index]?.hostId &&
        candidate.path === right[index]?.path,
    )
  )
}

function isRootGitEntry(root: HostPath, candidate: HostPath): boolean {
  return (
    root.hostId === candidate.hostId &&
    candidate.path === (root.path === '/' ? '/.git' : `${root.path}/.git`)
  )
}

function isInsideProjectPath(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}
