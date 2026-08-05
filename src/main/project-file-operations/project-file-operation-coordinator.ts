import { randomUUID } from 'node:crypto'

import {
  containsHostPath,
  hostPathEquals,
  isProjectFileEntryName,
  type ExternalFileGrantResult,
  type HostPath,
  type ProjectFileCreateKind,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOperationStartResult,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'
import { createProjectEntry } from './create-project-entry'
import type { ExternalFileGrantRegistry } from './external-file-grants'
import { copyExternalFileGrant } from './external-file-copy'
import {
  assertNormalizedAbsoluteProjectPath,
  projectFilePathKey,
  proveRealProjectDirectory,
} from './project-file-confinement'
import {
  PROJECT_FILE_COPY_LIMITS,
  type ProjectFileCopyLimits,
} from './verified-project-copy'
import { ProjectFileStagingCleanup } from './staging-cleanup'

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

export interface ProjectFileCreateInput {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: ProjectFileCreateKind
}

export interface ProjectFileExternalCopyInput {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly grantId: string
  readonly grantGeneration: number
  readonly publish: (progress: ProjectFileOperationProgress) => void
}

interface OperationIdentity {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly operationId: string
  readonly generation: number
  readonly projectId: string
  readonly workspaceId: string
  readonly host: ProjectHost
  readonly canonicalRoot: HostPath
}

interface ActiveOperation {
  readonly identity: OperationIdentity
  readonly abort: AbortController
  readonly publish?: (progress: ProjectFileOperationProgress) => void
  readonly totalItems?: number
  latestCompletedItems: number
}

class ProjectFileAuthorityError extends Error {}

export class ProjectFileOperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>()
  private readonly settlements = new Set<Promise<void>>()
  private readonly stagingCleanup = new ProjectFileStagingCleanup()
  private generation = 0
  private disposed = false

  constructor(
    private readonly options: {
      readonly resolveWorkspace: (
        root: HostPath,
      ) => ProjectFileWorkspaceAuthority | undefined
      readonly resources: ProjectFileOperationResourcePort
      readonly externalFiles?: ExternalFileGrantRegistry
      readonly readClipboardPaths?: () => readonly string[]
      readonly createOperationId?: () => string
      readonly createStagingId?: () => string
      readonly deadlineMs?: number
      readonly copyLimits?: ProjectFileCopyLimits
    },
  ) {}

  async create(input: ProjectFileCreateInput): Promise<ProjectFileOperationResult> {
    this.assertCreateInput(input)
    const authority = this.requireWorkspace(input.workspaceRoot)
    this.assertRenderer(input.owner)
    const canonicalRoot = await authority.host.realpath(authority.root)
    if ((await authority.host.stat(canonicalRoot)).type !== 'dir') {
      throw new Error('The registered workspace root is not a real directory')
    }
    this.assertAuthorityCurrent(input.owner, authority)

    const busy = this.busyReason(authority.root)
    if (busy) return { outcome: 'busy', reason: busy, items: [] }

    const identity: OperationIdentity = {
      owner: input.owner,
      workspaceRoot: input.workspaceRoot,
      operationId: this.options.createOperationId?.() ?? randomUUID(),
      generation: (this.generation += 1),
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      host: authority.host,
      canonicalRoot,
    }
    const abort = new AbortController()
    const lease = this.options.resources.registerOperation(
      identity.owner,
      identity.workspaceRoot,
      identity.operationId,
      () => abort.abort(new Error('Project file operation authority was revoked')),
    )
    const operation: ActiveOperation = { identity, abort, latestCompletedItems: 0 }
    this.active.set(identity.operationId, operation)
    const stopConnection = identity.host.onConnectionState((state) => {
      if (state !== 'connected') {
        abort.abort(new Error('The project host disconnected'))
      }
    })
    const deadline = setTimeout(
      () => abort.abort(new Error('The project file operation reached its deadline')),
      this.options.deadlineMs ?? PROJECT_FILE_OPERATION_DEADLINE_MS,
    )

    try {
      const item = await createProjectEntry({
        host: identity.host,
        workspaceRoot: identity.workspaceRoot,
        canonicalRoot: identity.canonicalRoot,
        destinationDirectory: input.destinationDirectory,
        name: input.name,
        kind: input.kind,
        signal: abort.signal,
        assertCurrent: () => this.assertOperationCurrent(identity, abort.signal),
      })
      return {
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: [item],
      }
    } finally {
      clearTimeout(deadline)
      void stopConnection()
      lease.release()
      this.active.delete(identity.operationId)
    }
  }

  acquireClipboard(owner: RendererOwner): Promise<ExternalFileGrantResult> {
    this.assertRenderer(owner)
    const externalFiles = this.requireExternalFiles()
    const paths = this.options.readClipboardPaths?.() ?? []
    return externalFiles.acquire(owner, paths)
  }

  acquireDropped(
    owner: RendererOwner,
    paths: readonly string[],
  ): Promise<ExternalFileGrantResult> {
    this.assertRenderer(owner)
    return this.requireExternalFiles().acquire(owner, paths)
  }

  async copyExternal(
    input: ProjectFileExternalCopyInput,
  ): Promise<ProjectFileOperationStartResult> {
    this.assertExternalCopyInput(input)
    const authority = this.requireWorkspace(input.workspaceRoot)
    this.assertRenderer(input.owner)
    const canonicalRoot = await authority.host.realpath(authority.root)
    if ((await authority.host.stat(canonicalRoot)).type !== 'dir') {
      throw new Error('The registered workspace root is not a real directory')
    }
    const canonicalDestinationDirectory = await proveRealProjectDirectory(
      authority.host,
      authority.root,
      canonicalRoot,
      input.destinationDirectory,
    )
    this.assertAuthorityCurrent(input.owner, authority)
    const busy = this.busyReason(authority.root)
    if (busy) return { outcome: 'busy', reason: busy }
    const stagingReservation = this.stagingCleanup.reserve(authority.host)
    if (!stagingReservation) {
      return {
        outcome: 'busy',
        reason: 'Pending staging cleanup has reached the host safety limit',
      }
    }

    let grant
    try {
      grant = this.requireExternalFiles().consume(
        input.owner,
        input.grantId,
        input.grantGeneration,
      )
    } catch (reason) {
      stagingReservation.release()
      throw reason
    }
    const identity: OperationIdentity = {
      owner: input.owner,
      workspaceRoot: input.workspaceRoot,
      operationId: this.options.createOperationId?.() ?? randomUUID(),
      generation: (this.generation += 1),
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      host: authority.host,
      canonicalRoot,
    }
    const abort = new AbortController()
    let lease: ProjectFileOperationResourceLease
    try {
      lease = this.options.resources.registerOperation(
        identity.owner,
        identity.workspaceRoot,
        identity.operationId,
        () => abort.abort(new Error('Project file operation authority was revoked')),
      )
    } catch (reason) {
      grant.revoke()
      stagingReservation.release()
      throw reason
    }
    const operation: ActiveOperation = {
      identity,
      abort,
      publish: input.publish,
      totalItems: grant.items.length,
      latestCompletedItems: 0,
    }
    this.active.set(identity.operationId, operation)
    const stopConnection = identity.host.onConnectionState((state) => {
      if (state !== 'connected') abort.abort(new Error('The project host disconnected'))
    })
    const deadline = setTimeout(
      () => abort.abort(new Error('The project file operation reached its deadline')),
      this.options.deadlineMs ?? PROJECT_FILE_OPERATION_DEADLINE_MS,
    )
    const settlement = new Promise<void>((resolveSettlement) => {
      setImmediate(() => {
        void copyExternalFileGrant({
          operationId: identity.operationId,
          generation: identity.generation,
          visibleDestinationDirectory: input.destinationDirectory,
          canonicalDestinationDirectory,
          destinationHost: identity.host,
          grant,
          signal: abort.signal,
          assertCurrent: () => {
            this.assertOperationCurrent(identity, abort.signal)
            grant.assertCurrent()
          },
          revalidateDestinationDirectory: () =>
            proveRealProjectDirectory(
              identity.host,
              identity.workspaceRoot,
              identity.canonicalRoot,
              input.destinationDirectory,
            ),
          limits: this.options.copyLimits ?? PROJECT_FILE_COPY_LIMITS,
          createStagingId: this.options.createStagingId,
          cleanupStaging: (host, path) => this.stagingCleanup.cleanup(host, path),
          onProgress: (completedItems, totalItems, currentName) => {
            operation.latestCompletedItems = completedItems
            this.publish(operation, {
              workspaceRoot: identity.workspaceRoot,
              operationId: identity.operationId,
              generation: identity.generation,
              phase: abort.signal.aborted ? 'cancelling' : 'copying',
              completedItems,
              totalItems,
              ...(currentName ? { currentName } : {}),
            })
          },
        })
          .then((result) =>
            this.publish(operation, {
              workspaceRoot: identity.workspaceRoot,
              operationId: identity.operationId,
              generation: identity.generation,
              phase: 'completed',
              completedItems: result.items.length,
              totalItems: grant.items.length,
              result,
            }),
          )
          .finally(() => {
            try {
              clearTimeout(deadline)
              void stopConnection()
              grant.revoke()
              stagingReservation.release()
              lease.release()
              this.active.delete(identity.operationId)
            } finally {
              resolveSettlement()
            }
          })
      })
    })
    this.settlements.add(settlement)
    void settlement.finally(() => this.settlements.delete(settlement))
    return {
      outcome: 'started',
      operationId: identity.operationId,
      generation: identity.generation,
      itemCount: grant.items.length,
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

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const operation of this.active.values()) {
      operation.abort.abort(new Error('Project file operations were disposed'))
    }
    this.options.externalFiles?.dispose()
    await Promise.allSettled([...this.settlements])
    await this.stagingCleanup.dispose()
  }

  private assertCreateInput(input: ProjectFileCreateInput): void {
    if (this.disposed) throw new Error('Project file operations are disposed')
    if (!isProjectFileEntryName(input.name)) throw new Error('Invalid entry name')
    if (input.kind !== 'file' && input.kind !== 'directory') {
      throw new Error('Invalid create operation kind')
    }
    assertNormalizedAbsoluteProjectPath(input.workspaceRoot)
    assertNormalizedAbsoluteProjectPath(input.destinationDirectory)
    if (!containsHostPath(input.workspaceRoot, input.destinationDirectory)) {
      throw new Error('The destination directory escapes the workspace')
    }
  }

  private assertExternalCopyInput(input: ProjectFileExternalCopyInput): void {
    if (this.disposed) throw new Error('Project file operations are disposed')
    assertNormalizedAbsoluteProjectPath(input.workspaceRoot)
    assertNormalizedAbsoluteProjectPath(input.destinationDirectory)
    if (!containsHostPath(input.workspaceRoot, input.destinationDirectory)) {
      throw new Error('The destination directory escapes the workspace')
    }
    if (!input.grantId || input.grantId.length > 256) {
      throw new Error('Invalid external file grant')
    }
    if (!Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) {
      throw new Error('Invalid external file grant generation')
    }
  }

  private requireExternalFiles(): ExternalFileGrantRegistry {
    if (this.disposed) throw new Error('Project file operations are disposed')
    if (!this.options.externalFiles) {
      throw new Error('External file operations are unavailable')
    }
    return this.options.externalFiles
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

  private publish(
    operation: ActiveOperation,
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

  private assertRenderer(owner: RendererOwner): void {
    if (!this.options.resources.isRendererCurrent(owner)) {
      throw new ProjectFileAuthorityError('The renderer owner is no longer current')
    }
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
      throw new ProjectFileAuthorityError(
        'The workspace authority was replaced or retired',
      )
    }
  }

  private assertOperationCurrent(identity: OperationIdentity, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.assertAuthorityCurrent(identity.owner, {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      root: identity.workspaceRoot,
      host: identity.host,
    })
  }
}
