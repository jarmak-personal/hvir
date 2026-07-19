import {
  asHostId,
  hostPath,
  hostPathEquals,
  type HostPath,
  type WorkerHostCall,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import { GIT_FETCH_ARGS, GIT_PULL_ARGS } from './git-engine'

export type GitMutationKind = 'worktree-prune' | 'branch-switch' | 'fetch' | 'pull'

export type GitMutationGrantRequest =
  | {
      readonly kind: 'branch-switch'
      readonly projectId: string
      readonly root: HostPath
      readonly target: string
    }
  | {
      readonly kind: Exclude<GitMutationKind, 'branch-switch'>
      readonly projectId: string
      readonly root: HostPath
      readonly target?: never
    }

export interface GitMutationAuthority {
  readonly projectId: string
  readonly host: ProjectHost
  readonly root: HostPath
}

export interface GitHostCallPermissions {
  readonly allowWorktreePrune?: boolean
  readonly allowBranchSwitch?: string
  readonly allowFetch?: boolean
  readonly allowPull?: boolean
}

export interface GitMutationGrant {
  readonly id: number
  revoke(): void
}

export interface GitMutationAuthorizationOptions {
  readonly now?: () => number
  readonly grantTtlMs?: number
  readonly historyRetentionMs?: number
}

interface GrantRecord {
  readonly id: number
  readonly key: string
  readonly request: GitMutationGrantRequest
  readonly expiresAt: number
}

interface DenialRecord {
  readonly reason: 'consumed' | 'expired' | 'revoked'
  readonly recordedAt: number
}

interface WorkerMutation {
  readonly kind: GitMutationKind
  readonly root: HostPath
  readonly target?: string
}

const DEFAULT_GRANT_TTL_MS = 5 * 60_000
const DEFAULT_HISTORY_RETENTION_MS = 10 * 60_000
const MAX_HISTORY = 1_024
const PRUNE_ARGS = ['worktree', 'prune', '--expire', 'now', '--verbose'] as const

/**
 * Owns exact, one-shot Git mutation grants.
 *
 * A grant is consumed before the matching host call is dispatched, even when Git later
 * fails. Callers revoke the handle in `finally` so cancelled or preflight-only worker
 * requests cannot leave ambient permission behind.
 */
export class GitMutationAuthorization {
  private readonly grants = new Map<number, GrantRecord>()
  private readonly grantByKey = new Map<string, number>()
  private readonly history = new Map<string, DenialRecord>()
  private readonly now: () => number
  private readonly grantTtlMs: number
  private readonly historyRetentionMs: number
  private nextId = 1
  private disposed = false

  constructor(options: GitMutationAuthorizationOptions = {}) {
    this.now = options.now ?? Date.now
    this.grantTtlMs = positiveDuration(
      options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
      'grant TTL',
    )
    this.historyRetentionMs = positiveDuration(
      options.historyRetentionMs ?? DEFAULT_HISTORY_RETENTION_MS,
      'history retention',
    )
  }

  grant(request: GitMutationGrantRequest): GitMutationGrant {
    if (this.disposed) throw new Error('Git mutation authorization is disposed')
    validateGrantRequest(request)
    this.purge()
    const key = grantKey(request)
    if (this.grantByKey.has(key)) {
      throw new Error(`Git ${request.kind} denied: an exact grant is already active`)
    }
    const id = this.nextId++
    const record = {
      id,
      key,
      request,
      expiresAt: this.now() + this.grantTtlMs,
    }
    this.grants.set(id, record)
    this.grantByKey.set(key, id)
    this.history.delete(key)
    return { id, revoke: () => this.revoke(id) }
  }

  permissionsFor(
    call: WorkerHostCall,
    authority: GitMutationAuthority | null,
  ): GitHostCallPermissions {
    const mutation = workerMutation(call)
    if (!mutation) return {}
    this.purge()
    if (!authority) {
      throw new Error(`Git ${mutation.kind} denied: no registered project authority`)
    }
    if (
      call.hostId !== authority.host.hostId ||
      !hostPathEquals(mutation.root, authority.root)
    ) {
      throw new Error(
        `Git ${mutation.kind} denied: command root is not an exact workspace`,
      )
    }
    const key = exactGrantKey(
      authority.projectId,
      mutation.root,
      mutation.kind,
      mutation.target,
    )
    const id = this.grantByKey.get(key)
    if (id === undefined) {
      const denial = this.history.get(key)
      const reason = denial ? `grant was already ${denial.reason}` : 'no exact grant'
      throw new Error(`Git ${mutation.kind} denied: ${reason}`)
    }
    const grant = this.grants.get(id)
    if (!grant) throw new Error(`Git ${mutation.kind} denied: no exact grant`)
    this.remove(grant, 'consumed')
    return permissions(grant.request)
  }

  revokeAll(): void {
    for (const grant of [...this.grants.values()]) this.remove(grant, 'revoked')
  }

  dispose(): void {
    if (this.disposed) return
    this.revokeAll()
    this.disposed = true
  }

  private revoke(id: number): void {
    const grant = this.grants.get(id)
    if (grant) this.remove(grant, 'revoked')
  }

  private remove(grant: GrantRecord, reason: DenialRecord['reason']): void {
    this.grants.delete(grant.id)
    if (this.grantByKey.get(grant.key) === grant.id) this.grantByKey.delete(grant.key)
    this.history.set(grant.key, { reason, recordedAt: this.now() })
    this.trimHistory()
  }

  private purge(): void {
    const now = this.now()
    for (const grant of [...this.grants.values()]) {
      if (grant.expiresAt <= now) this.remove(grant, 'expired')
    }
    for (const [key, denial] of this.history) {
      if (denial.recordedAt + this.historyRetentionMs <= now) this.history.delete(key)
    }
    this.trimHistory()
  }

  private trimHistory(): void {
    while (this.history.size > MAX_HISTORY) {
      const oldest = this.history.keys().next().value
      if (oldest === undefined) return
      this.history.delete(oldest)
    }
  }
}

function workerMutation(call: WorkerHostCall): WorkerMutation | undefined {
  if (
    call.operation !== 'exec' ||
    call.command !== 'git' ||
    call.cwd !== undefined ||
    call.input !== undefined ||
    call.allowTruncatedOutput !== undefined ||
    call.maxStdoutNulRecords !== undefined ||
    call.args.length < 3 ||
    call.args[0] !== '-C'
  ) {
    return undefined
  }
  const rawRoot = call.args[1]
  if (typeof rawRoot !== 'string' || !rawRoot.startsWith('/') || rawRoot.includes('\0')) {
    return undefined
  }
  const root = hostPath(asHostId(call.hostId), rawRoot)
  if (root.path !== rawRoot) return undefined
  const command = call.args.slice(2)
  if (sameArgs(command, PRUNE_ARGS)) return { kind: 'worktree-prune', root }
  if (sameArgs(command, GIT_FETCH_ARGS)) return { kind: 'fetch', root }
  if (sameArgs(command, GIT_PULL_ARGS)) return { kind: 'pull', root }
  if (
    command.length === 3 &&
    command[0] === 'switch' &&
    command[1] === '--no-guess' &&
    typeof command[2] === 'string'
  ) {
    return { kind: 'branch-switch', root, target: command[2] }
  }
  return undefined
}

function permissions(request: GitMutationGrantRequest): GitHostCallPermissions {
  switch (request.kind) {
    case 'worktree-prune':
      return { allowWorktreePrune: true }
    case 'branch-switch':
      return { allowBranchSwitch: request.target }
    case 'fetch':
      return { allowFetch: true }
    case 'pull':
      return { allowPull: true }
  }
}

function validateGrantRequest(request: GitMutationGrantRequest): void {
  if (!isGitMutationKind(request.kind)) {
    throw new Error('Invalid Git mutation kind')
  }
  if (
    typeof request.projectId !== 'string' ||
    request.projectId.length === 0 ||
    request.projectId.length > 256 ||
    request.projectId.includes('\0')
  ) {
    throw new Error('Invalid Git mutation project')
  }
  if (
    !request.root.path.startsWith('/') ||
    request.root.path.length > 16_384 ||
    request.root.path.includes('\0') ||
    request.root.hostId.length === 0 ||
    request.root.hostId.length > 256 ||
    request.root.hostId.includes('\0') ||
    hostPath(request.root.hostId, request.root.path).path !== request.root.path
  ) {
    throw new Error('Invalid Git mutation root')
  }
  if (
    request.kind === 'branch-switch' &&
    (request.target.length === 0 ||
      request.target.length > 1_024 ||
      request.target.includes('\0'))
  ) {
    throw new Error('Invalid Git mutation target')
  }
  if (request.kind !== 'branch-switch' && request.target !== undefined) {
    throw new Error('Invalid Git mutation target')
  }
}

function isGitMutationKind(value: string): value is GitMutationKind {
  return (
    value === 'worktree-prune' ||
    value === 'branch-switch' ||
    value === 'fetch' ||
    value === 'pull'
  )
}

function grantKey(request: GitMutationGrantRequest): string {
  return exactGrantKey(
    request.projectId,
    request.root,
    request.kind,
    request.kind === 'branch-switch' ? request.target : undefined,
  )
}

function exactGrantKey(
  projectId: string,
  root: HostPath,
  kind: GitMutationKind,
  target?: string,
): string {
  return JSON.stringify([
    projectId,
    root.hostId,
    root.path,
    kind,
    kind === 'branch-switch' ? target : null,
  ])
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((arg, index) => arg === expected[index])
  )
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`)
  return value
}
