import {
  MAX_PROJECT_WATCH_INTERESTS,
  hostPathEquals,
  type HostPath,
  type IpcEventPayload,
  type ProjectState,
  type ProjectWatchInterestsResponse,
  type RegisteredProjectState,
  type WorktreeDiscovery,
} from '../shared'
import type { ProjectHost } from './project-host'
import {
  canonicalProjectWatchInterests,
  type ProjectWatchCallbacks,
  type ProjectWatchInterestCache,
  type ProjectWatchTarget,
} from './project-watch'

export interface WorkspaceRegistryPort {
  readonly active: {
    readonly host: ProjectHost
    readonly root: HostPath
    readonly projectId: string
    readonly workspaceId: string
  }
  state(): ProjectState
  projectById(projectId: string): RegisteredProjectState | undefined
  reconcileWorktrees(
    projectId: string,
    discovery: WorktreeDiscovery,
  ): Promise<ProjectState>
  updateChangedCounts(
    projectId: string,
    counts: ReadonlyMap<string, number>,
  ): Promise<ProjectState>
}

export interface WorkspaceDiscoveryPort {
  discover(root: HostPath): Promise<WorktreeDiscovery>
  changedFileCount(root: HostPath, relatedRoots: readonly HostPath[]): Promise<number>
}

export interface WorkspaceWatchPort {
  readonly target: ProjectWatchTarget
  updateInterests(interests: readonly HostPath[]): void
  dispose(): Promise<void>
}

export interface WorkspaceCoordinatorOptions {
  readonly registry: WorkspaceRegistryPort
  readonly discovery: WorkspaceDiscoveryPort
  readonly emitWatch: (event: IpcEventPayload<'project:watch'>) => void
  readonly createWatch: (
    target: ProjectWatchTarget,
    callbacks: ProjectWatchCallbacks,
  ) => WorkspaceWatchPort
  readonly shouldPoll?: () => boolean
  readonly onError?: (message: string, error: unknown) => void
}

/** Owns watch replacement, refresh deduplication, polling, and transition serialization. */
export class WorkspaceCoordinator {
  private readonly refreshes = new Map<string, Promise<ProjectState>>()
  private readonly exclusiveOperations = new Map<string, Promise<ProjectState>>()
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly projectGenerations = new Map<string, number>()
  private watch?: WorkspaceWatchPort
  private watchGeneration = 0
  private watchInterestCache: ProjectWatchInterestCache = new Map()
  private pollTimer?: ReturnType<typeof setInterval>
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: WorkspaceCoordinatorOptions) {}

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  refresh(projectId: string): Promise<ProjectState> {
    const exclusive = this.exclusiveOperations.get(projectId)
    if (exclusive) return exclusive
    const existing = this.refreshes.get(projectId)
    if (existing) return existing
    const generation = this.projectGeneration(projectId)
    const refresh = this.refreshProject(projectId, generation)
    this.refreshes.set(projectId, refresh)
    void refresh.then(
      () => this.releaseRefresh(projectId, refresh),
      () => this.releaseRefresh(projectId, refresh),
    )
    return refresh
  }

  scheduleRefresh(projectId: string, delayMs = 350): void {
    if (this.disposed) return
    const existing = this.refreshTimers.get(projectId)
    if (existing) clearTimeout(existing)
    this.refreshTimers.set(
      projectId,
      setTimeout(() => {
        this.refreshTimers.delete(projectId)
        void this.refresh(projectId).catch((error) =>
          this.report(`[workspace] watch refresh failed for ${projectId}`, error),
        )
      }, delayMs),
    )
  }

  coalesceProjectOperation(
    projectId: string,
    operation: () => Promise<ProjectState>,
  ): Promise<ProjectState> {
    const existing = this.exclusiveOperations.get(projectId)
    if (existing) return existing
    const result = this.serialize(operation)
    this.exclusiveOperations.set(projectId, result)
    void result.then(
      () => this.releaseExclusive(projectId, result),
      () => this.releaseExclusive(projectId, result),
    )
    return result
  }

  async replaceWatch(target?: ProjectWatchTarget): Promise<void> {
    const generation = ++this.watchGeneration
    this.watchInterestCache.clear()
    const previous = this.watch
    this.watch = undefined
    await previous?.dispose()
    if (
      this.disposed ||
      generation !== this.watchGeneration ||
      !target ||
      target.host.connectionState !== 'connected'
    ) {
      return
    }
    const owner: { controller?: WorkspaceWatchPort } = {}
    const created = this.options.createWatch(target, {
      emit: (event) => {
        if (generation === this.watchGeneration && this.watch === owner.controller) {
          this.options.emitWatch(event)
        }
      },
      refreshGit: () => {
        if (generation === this.watchGeneration && this.watch === owner.controller) {
          this.scheduleRefresh(target.projectId)
        }
      },
      repositoryEnabled: () => {
        if (generation !== this.watchGeneration || this.watch !== owner.controller) {
          return false
        }
        const active = this.options.registry.active
        const workspace = this.options.registry
          .projectById(target.projectId)
          ?.workspaces.find((candidate) => candidate.id === active.workspaceId)
        return workspace?.repository === true
      },
    })
    owner.controller = created
    if (generation === this.watchGeneration && !this.disposed) {
      this.watch = created
    } else {
      await created.dispose()
    }
  }

  stopWatch(): Promise<void> {
    return this.replaceWatch()
  }

  async updateWatchInterests(
    requestedPaths: readonly HostPath[],
  ): Promise<ProjectWatchInterestsResponse> {
    const controller = this.watch
    if (!controller) throw new Error('Project watch is unavailable')
    const generation = this.watchGeneration
    const { host, root } = this.options.registry.active
    if (!hostPathEquals(controller.target.root, root)) {
      throw new Error('Project watch changed while interests were being updated')
    }
    const canonical = await canonicalProjectWatchInterests(
      host,
      root,
      requestedPaths,
      MAX_PROJECT_WATCH_INTERESTS,
      this.watchInterestCache,
    )
    if (
      generation !== this.watchGeneration ||
      this.watch !== controller ||
      !hostPathEquals(this.options.registry.active.root, root)
    ) {
      throw new Error('Project watch changed while interests were being updated')
    }
    controller.updateInterests(canonical.paths)
    return { accepted: canonical.paths.length, limited: canonical.limited }
  }

  invalidateProject(projectId: string): void {
    this.projectGenerations.set(projectId, this.projectGeneration(projectId) + 1)
    const timer = this.refreshTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.refreshTimers.delete(projectId)
  }

  async settleProject(projectId: string): Promise<void> {
    const refresh = this.refreshes.get(projectId)
    const exclusive = this.exclusiveOperations.get(projectId)
    await refresh?.catch(() => undefined)
    await exclusive?.catch(() => undefined)
  }

  async settle(): Promise<void> {
    await Promise.allSettled([
      this.operationTail,
      ...this.refreshes.values(),
      ...this.exclusiveOperations.values(),
    ])
  }

  startPolling(intervalMs = 5_000): void {
    if (this.pollTimer || this.disposed) return
    this.pollTimer = setInterval(() => this.poll(), intervalMs)
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopPolling()
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
    await this.stopWatch()
    await this.settle()
  }

  private async refreshProject(
    projectId: string,
    generation: number,
  ): Promise<ProjectState> {
    const project = this.options.registry.projectById(projectId)
    if (!project) throw new Error('Unknown project')
    if (project.connectionState !== 'connected') return this.options.registry.state()
    const discovery = await this.options.discovery.discover(project.registeredRoot)
    if (!this.isCurrent(projectId, generation)) return this.options.registry.state()
    await this.options.registry.reconcileWorktrees(projectId, discovery)
    if (!this.isCurrent(projectId, generation) || !discovery.repository) {
      return this.options.registry.state()
    }
    const refreshed = this.options.registry.projectById(projectId)
    if (!refreshed) return this.options.registry.state()
    const present = refreshed.workspaces.filter((workspace) => !workspace.missing)
    const relatedRoots = present.map((workspace) => workspace.root)
    const counts = new Map<string, number>()
    for (let index = 0; index < present.length; index += 3) {
      await Promise.all(
        present.slice(index, index + 3).map(async (workspace) => {
          counts.set(
            workspace.id,
            await this.options.discovery.changedFileCount(workspace.root, relatedRoots),
          )
        }),
      )
      if (!this.isCurrent(projectId, generation)) return this.options.registry.state()
    }
    return this.options.registry.updateChangedCounts(projectId, counts)
  }

  private poll(): void {
    if (this.disposed || this.options.shouldPoll?.() === false) return
    for (const project of this.options.registry.state().projects) {
      if (
        project.connectionState !== 'connected' ||
        project.workspaces.every((workspace) => workspace.repository === false)
      ) {
        continue
      }
      void this.refresh(project.id).catch((error) =>
        this.report(`[workspace] periodic refresh failed for ${project.id}`, error),
      )
    }
  }

  private projectGeneration(projectId: string): number {
    return this.projectGenerations.get(projectId) ?? 0
  }

  private isCurrent(projectId: string, generation: number): boolean {
    return !this.disposed && generation === this.projectGeneration(projectId)
  }

  private releaseRefresh(projectId: string, refresh: Promise<ProjectState>): void {
    if (this.refreshes.get(projectId) === refresh) this.refreshes.delete(projectId)
  }

  private releaseExclusive(projectId: string, result: Promise<ProjectState>): void {
    if (this.exclusiveOperations.get(projectId) === result) {
      this.exclusiveOperations.delete(projectId)
    }
  }

  private report(message: string, error: unknown): void {
    if (this.options.onError) this.options.onError(message, error)
    else console.error(message, error)
  }
}
