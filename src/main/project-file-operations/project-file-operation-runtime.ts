import { randomUUID } from 'node:crypto'

import {
  hostPathEquals,
  type Disposer,
  type HostPath,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import { projectFilePathKey } from './project-file-confinement'

export const PROJECT_FILE_OPERATION_DEADLINE_MS = 10 * 60 * 1_000

export interface ProjectFileWorkspaceAuthority {
  readonly projectId: string
  readonly workspaceId: string
  readonly root: HostPath
  readonly host: ProjectHost
}

export interface ProjectFileOperationResourceLease {
  release(): void
}

export interface ProjectFileOperationResourcePort {
  isRendererCurrent(owner: RendererOwner): boolean
  registerOperation(
    owner: RendererOwner,
    root: HostPath,
    operationId: string,
    revoke: () => void,
  ): ProjectFileOperationResourceLease
}

export interface ProjectFileOperationIdentity {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly operationId: string
  readonly generation: number
  readonly projectId: string
  readonly workspaceId: string
  readonly host: ProjectHost
  readonly canonicalRoot: HostPath
}

export interface ActiveProjectFileOperation {
  readonly identity: ProjectFileOperationIdentity
  readonly abort: AbortController
  readonly publish?: (progress: ProjectFileOperationProgress) => void
  readonly totalItems?: number
  latestCompletedItems: number
  readonly lease: ProjectFileOperationResourceLease
  readonly stopConnection: Disposer
  readonly deadline: ReturnType<typeof setTimeout>
}

export class ProjectFileOperationRuntime {
  private readonly active = new Map<string, ActiveProjectFileOperation>()
  private readonly settlements = new Set<Promise<void>>()
  private generation = 0
  private disposed = false

  constructor(
    private readonly options: {
      readonly resolveWorkspace: (
        root: HostPath,
      ) => ProjectFileWorkspaceAuthority | undefined
      readonly resources: ProjectFileOperationResourcePort
      readonly createOperationId?: () => string
      readonly deadlineMs?: number
    },
  ) {}

  get isDisposed(): boolean {
    return this.disposed
  }

  async prepare(
    owner: RendererOwner,
    workspaceRoot: HostPath,
  ): Promise<ProjectFileOperationIdentity> {
    if (this.disposed) throw new Error('Project file operations are disposed')
    const authority = this.requireWorkspace(workspaceRoot)
    this.assertRenderer(owner)
    const canonicalRoot = await authority.host.realpath(authority.root)
    if ((await authority.host.stat(canonicalRoot)).type !== 'dir') {
      throw new Error('The registered workspace root is not a real directory')
    }
    this.assertAuthorityCurrent(owner, authority)
    return {
      owner,
      workspaceRoot,
      operationId: this.options.createOperationId?.() ?? randomUUID(),
      generation: (this.generation += 1),
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      host: authority.host,
      canonicalRoot,
    }
  }

  activate(
    identity: ProjectFileOperationIdentity,
    publish?: (progress: ProjectFileOperationProgress) => void,
    totalItems?: number,
  ):
    | { readonly outcome: 'busy'; readonly reason: string }
    | { readonly outcome: 'active'; readonly operation: ActiveProjectFileOperation } {
    this.assertAuthorityCurrent(identity.owner, {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      root: identity.workspaceRoot,
      host: identity.host,
    })
    const busy = this.busyReason(identity.workspaceRoot)
    if (busy) return { outcome: 'busy', reason: busy }
    const abort = new AbortController()
    const lease = this.options.resources.registerOperation(
      identity.owner,
      identity.workspaceRoot,
      identity.operationId,
      () => abort.abort(new Error('Project file operation authority was revoked')),
    )
    const deadline = setTimeout(
      () => abort.abort(new Error('The project file operation reached its deadline')),
      this.options.deadlineMs ?? PROJECT_FILE_OPERATION_DEADLINE_MS,
    )
    let stopConnection: Disposer
    try {
      stopConnection = identity.host.onConnectionState((state) => {
        if (state !== 'connected') abort.abort(new Error('The project host disconnected'))
      })
    } catch (reason) {
      try {
        clearTimeout(deadline)
      } finally {
        lease.release()
      }
      throw reason
    }
    const operation: ActiveProjectFileOperation = {
      identity,
      abort,
      publish,
      totalItems,
      latestCompletedItems: 0,
      lease,
      stopConnection,
      deadline,
    }
    this.active.set(identity.operationId, operation)
    return { outcome: 'active', operation }
  }

  launch(
    operation: ActiveProjectFileOperation,
    run: () => Promise<ProjectFileOperationResult>,
    recover: (reason: unknown) => ProjectFileOperationResult,
    cleanup: () => void,
  ): void {
    const settlement = new Promise<void>((resolveSettlement) => {
      setImmediate(() => {
        const task = Promise.resolve()
          .then(run)
          .catch(recover)
          .then((result) =>
            this.publish(operation, {
              workspaceRoot: operation.identity.workspaceRoot,
              operationId: operation.identity.operationId,
              generation: operation.identity.generation,
              phase: 'completed',
              completedItems: result.items.length,
              totalItems: operation.totalItems ?? result.items.length,
              result,
            }),
          )
          .finally(async () => {
            try {
              cleanup()
            } finally {
              try {
                await this.release(operation)
              } finally {
                resolveSettlement()
              }
            }
          })
        void task.catch(() => undefined)
      })
    })
    this.settlements.add(settlement)
    void settlement.finally(() => this.settlements.delete(settlement))
  }

  publish(
    operation: ActiveProjectFileOperation,
    progress: ProjectFileOperationProgress,
  ): void {
    if (this.active.get(operation.identity.operationId) !== operation) return
    if (!this.options.resources.isRendererCurrent(operation.identity.owner)) return
    try {
      operation.publish?.(progress)
    } catch {
      // A renderer listener cannot change operation ownership or completion.
    }
  }

  assertCurrent(identity: ProjectFileOperationIdentity, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.assertAuthorityCurrent(identity.owner, {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      root: identity.workspaceRoot,
      host: identity.host,
    })
  }

  async release(operation: ActiveProjectFileOperation): Promise<void> {
    if (this.active.get(operation.identity.operationId) !== operation) return
    clearTimeout(operation.deadline)
    try {
      await operation.stopConnection()
    } finally {
      try {
        operation.lease.release()
      } finally {
        this.active.delete(operation.identity.operationId)
      }
    }
  }

  cancel(owner: RendererOwner, operationId: string, generation: number): boolean {
    this.assertRenderer(owner)
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) {
      throw new Error('Invalid project file operation ID')
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('Invalid project file operation generation')
    }
    const operation = this.active.get(operationId)
    if (
      !operation ||
      operation.identity.generation !== generation ||
      operation.identity.owner.id !== owner.id ||
      operation.identity.owner.generation !== owner.generation
    ) {
      return false
    }
    operation.abort.abort(new Error('The project file operation was cancelled'))
    this.publish(operation, {
      workspaceRoot: operation.identity.workspaceRoot,
      operationId,
      generation,
      phase: 'cancelling',
      completedItems: operation.latestCompletedItems,
      totalItems: operation.totalItems ?? 0,
    })
    return true
  }

  assertRenderer(owner: RendererOwner): void {
    if (!this.options.resources.isRendererCurrent(owner)) {
      throw new Error('The renderer owner is no longer current')
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const operation of this.active.values()) {
      operation.abort.abort(new Error('Project file operations were disposed'))
    }
    await Promise.allSettled([...this.settlements])
  }

  private busyReason(root: HostPath): string | undefined {
    const workspaceKey = projectFilePathKey(root)
    if (
      [...this.active.values()].some(
        (operation) =>
          projectFilePathKey(operation.identity.workspaceRoot) === workspaceKey,
      )
    ) {
      return 'Another file operation is already active for this workspace'
    }
    if (this.active.size >= 2) {
      return 'The application-wide file operation limit is currently in use'
    }
    return undefined
  }

  private requireWorkspace(root: HostPath): ProjectFileWorkspaceAuthority {
    const authority = this.options.resolveWorkspace(root)
    if (
      !authority ||
      !hostPathEquals(authority.root, root) ||
      authority.host.hostId !== root.hostId ||
      authority.host.connectionState !== 'connected'
    ) {
      throw new Error('The workspace is no longer available')
    }
    return authority
  }

  private assertAuthorityCurrent(
    owner: RendererOwner,
    expected: ProjectFileWorkspaceAuthority,
  ): void {
    this.assertRenderer(owner)
    const current = this.options.resolveWorkspace(expected.root)
    if (
      !current ||
      current.projectId !== expected.projectId ||
      current.workspaceId !== expected.workspaceId ||
      !hostPathEquals(current.root, expected.root) ||
      current.host !== expected.host ||
      current.host.connectionState !== 'connected'
    ) {
      throw new Error('The workspace authority was replaced or retired')
    }
  }
}
