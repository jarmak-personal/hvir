import { randomUUID } from 'node:crypto'

import {
  containsHostPath,
  hostPathEquals,
  isProjectFileEntryName,
  joinHostPath,
  type HostPath,
  type ProjectFileCreateKind,
  type ProjectFileItemResult,
  type ProjectFileOperationResult,
} from '../../shared'
import { isProjectPathExistsError, type ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'

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

interface OperationIdentity extends ProjectFileCreateInput {
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
}

class ProjectFileAuthorityError extends Error {}

export class ProjectFileOperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>()
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

  async create(input: ProjectFileCreateInput): Promise<ProjectFileOperationResult> {
    this.assertCreateInput(input)
    const authority = this.requireWorkspace(input.workspaceRoot)
    this.assertRenderer(input.owner)
    const canonicalRoot = await authority.host.realpath(authority.root)
    if ((await authority.host.lstat(canonicalRoot)).type !== 'dir') {
      throw new Error('The registered workspace root is not a real directory')
    }
    this.assertAuthorityCurrent(input.owner, authority)

    const workspaceKey = pathKey(authority.root)
    if (
      this.active.size >= 2 ||
      [...this.active.values()].some(
        (operation) => pathKey(operation.identity.workspaceRoot) === workspaceKey,
      )
    ) {
      return {
        outcome: 'busy',
        reason: 'Another file operation is already active for this workspace',
        items: [],
      }
    }

    const identity: OperationIdentity = {
      ...input,
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
    const operation: ActiveOperation = { identity, abort }
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
      const item = await this.createItem(identity, abort.signal)
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const operation of this.active.values()) {
      operation.abort.abort(new Error('Project file operations were disposed'))
    }
  }

  private async createItem(
    identity: OperationIdentity,
    signal: AbortSignal,
  ): Promise<ProjectFileItemResult> {
    const destination = joinHostPath(identity.destinationDirectory, identity.name)
    const itemId = 'create:0'
    try {
      this.assertOperationCurrent(identity, signal)
      const canonicalDirectory = await proveRealDirectory(
        identity.host,
        identity.workspaceRoot,
        identity.canonicalRoot,
        identity.destinationDirectory,
      )
      this.assertOperationCurrent(identity, signal)
      const canonicalDestination = joinHostPath(canonicalDirectory, identity.name)
      try {
        await identity.host.lstat(canonicalDestination)
        return {
          itemId,
          destination,
          status: 'conflicted',
          effect: 'none',
          reason: 'The destination already exists',
        }
      } catch (reason) {
        if (!isMissingPathError(reason)) throw reason
      }
      this.assertOperationCurrent(identity, signal)
      if (identity.kind === 'file') {
        await identity.host.createFileExclusive(canonicalDestination, {
          mode: 0o644,
          signal,
        })
      } else {
        await identity.host.createDirectoryExclusive(canonicalDestination, {
          mode: 0o755,
          signal,
        })
      }
      return {
        itemId,
        destination,
        status: 'completed',
        effect: identity.kind === 'file' ? 'created-file' : 'created-directory',
      }
    } catch (reason) {
      if (isProjectPathExistsError(reason)) {
        return {
          itemId,
          destination,
          status: 'conflicted',
          effect: 'none',
          reason: 'The destination already exists',
        }
      }
      if (
        signal.aborted ||
        isAbortError(reason) ||
        reason instanceof ProjectFileAuthorityError
      ) {
        return {
          itemId,
          destination,
          status: 'cancelled',
          effect: 'none',
          reason: boundedReason(signal.reason ?? reason, 'The operation was cancelled'),
        }
      }
      return {
        itemId,
        destination,
        status: 'failed',
        effect: 'none',
        reason: boundedReason(reason, 'The entry could not be created'),
      }
    }
  }

  private assertCreateInput(input: ProjectFileCreateInput): void {
    if (this.disposed) throw new Error('Project file operations are disposed')
    if (!isProjectFileEntryName(input.name)) throw new Error('Invalid entry name')
    if (input.kind !== 'file' && input.kind !== 'directory') {
      throw new Error('Invalid create operation kind')
    }
    assertNormalizedAbsolutePath(input.workspaceRoot)
    assertNormalizedAbsolutePath(input.destinationDirectory)
    if (!containsHostPath(input.workspaceRoot, input.destinationDirectory)) {
      throw new Error('The destination directory escapes the workspace')
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

async function proveRealDirectory(
  host: ProjectHost,
  workspaceRoot: HostPath,
  canonicalRoot: HostPath,
  directory: HostPath,
): Promise<HostPath> {
  if (!containsHostPath(workspaceRoot, directory)) {
    throw new Error('The destination directory escapes the workspace')
  }
  const suffix =
    directory.path === workspaceRoot.path
      ? ''
      : directory.path.slice(
          workspaceRoot.path === '/' ? 1 : workspaceRoot.path.length + 1,
        )
  let candidate = canonicalRoot
  if ((await host.lstat(candidate)).type !== 'dir') {
    throw new Error('The workspace root is not a real directory')
  }
  for (const segment of suffix ? suffix.split('/') : []) {
    if (!isProjectFileEntryName(segment)) {
      throw new Error('The destination directory is not a normalized project path')
    }
    candidate = joinHostPath(candidate, segment)
    if ((await host.lstat(candidate)).type !== 'dir') {
      throw new Error('The destination traverses a non-directory or symbolic link')
    }
  }
  return candidate
}

function assertNormalizedAbsolutePath(path: HostPath): void {
  if (
    !path ||
    typeof path.hostId !== 'string' ||
    typeof path.path !== 'string' ||
    !path.path.startsWith('/') ||
    path.path.includes('\0') ||
    path.path.includes('//') ||
    (path.path !== '/' && path.path.endsWith('/')) ||
    path.path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid host-qualified project path')
  }
}

function pathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}

function isMissingPathError(reason: unknown): boolean {
  const code =
    typeof reason === 'object' && reason !== null
      ? (reason as { code?: unknown }).code
      : undefined
  const message = reason instanceof Error ? reason.message : ''
  return code === 'ENOENT' || code === 2 || /no such file|not found/i.test(message)
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError'
}

function boundedReason(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : fallback
  return (message || fallback).slice(0, 240)
}
