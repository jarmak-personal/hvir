import { randomUUID } from 'node:crypto'
import { hostPathEquals } from '../../shared/host-path'
import type { SkillagerRequest, SkillagerResult } from '../../shared/skillager'
import type {
  SkillagerSyncCompletion,
  SkillagerSyncPreparation,
  SkillagerSyncRequest,
} from '../../shared/skillager-library-sync'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'
import type { SkillagerReviewGrant } from './skillager-review-owner'
import type { SkillagerLibrarySyncCliPort } from './skillager-library-sync-port'
import { SkillagerError, SKILLAGER_REQUEST_DEADLINE_MS } from './skillager-port'

interface Session {
  readonly id: string
  readonly owner: RendererOwner
  readonly request: SkillagerRequest
  readonly grant: SkillagerReviewGrant
  readonly libraryKey: string
  readonly contextKey: string
  readonly controller: AbortController
  lease?: RendererResourceLease
  pending?: Promise<unknown>
  ready: boolean
  revoked: boolean
}

/** Observation permits one explicit continuation; uncertain writes survive view revocation. */
export class SkillagerLibrarySyncOwner {
  private readonly sessions = new Map<string, Session>()
  private readonly latest = new Map<string, number>()
  private readonly uncertain = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly cli: SkillagerLibrarySyncCliPort,
    private readonly resources: Pick<
      RendererResourceScopes,
      'register' | 'assertCurrent'
    >,
    private readonly authorize: (
      owner: RendererOwner,
      request: SkillagerRequest,
    ) => SkillagerReviewGrant,
  ) {}

  async observe(
    owner: RendererOwner,
    request: SkillagerRequest,
  ): Promise<SkillagerResult<SkillagerSyncPreparation>> {
    let session: Session | undefined
    try {
      const grant = this.authorize(owner, request)
      this.admit(owner, request)
      const selected = grant.selection.library!
      const libraryKey = JSON.stringify([
        grant.selection.catalog,
        selected.id,
        selected.root,
      ])
      this.available(libraryKey)
      const old = this.sessions.get(ownerKey(owner))
      if (old) await this.release(old)
      grant.assertCurrent()
      if (this.latest.get(ownerKey(owner)) !== request.requestId)
        throw new SkillagerError('cancelled', 'Library observation was replaced.')
      session = {
        id: randomUUID(),
        owner,
        request,
        grant,
        libraryKey,
        contextKey:
          request.workspaceRoot.hostId === 'local'
            ? JSON.stringify(request.workspaceRoot)
            : 'personal-local-context',
        controller: new AbortController(),
        ready: false,
        revoked: false,
      }
      const current = session
      this.sessions.set(ownerKey(owner), current)
      current.lease = this.resources.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'skillager-request',
          root: request.workspaceRoot,
          id: `sync:${current.id}`,
        },
        () => this.release(current),
      )
      const previous = this.uncertain.get(libraryKey)
      const report = await this.run(current, () =>
        this.cli.syncStatus(
          grant.selection,
          request.workspaceRoot,
          current.controller.signal,
        ),
      )
      this.current(current)
      if (
        report.status === 'observed' &&
        report.library &&
        report.context &&
        report.coverage.complete &&
        previous === current.contextKey
      )
        this.uncertain.delete(libraryKey)
      const observed =
        report.status === 'observed' &&
        report.coverage.complete &&
        Boolean(report.library && report.context) &&
        !this.uncertain.has(libraryKey)
      current.ready = observed && previous === undefined
      return {
        ok: true,
        value: {
          report,
          observationId: observed ? current.id : undefined,
          requiresNewSync: previous !== undefined,
        },
      }
    } catch (error) {
      if (session) await this.release(session)
      return failure(error)
    }
  }

  async apply(
    owner: RendererOwner,
    request: SkillagerSyncRequest,
  ): Promise<SkillagerResult<SkillagerSyncCompletion>> {
    let session: Session | undefined
    let submitted = false
    try {
      this.authorize(owner, request).assertCurrent()
      this.admit(owner, request)
      session = this.sessions.get(ownerKey(owner))
      if (
        !session ||
        session.id !== request.observationId ||
        !session.ready ||
        session.request.connectionId !== request.connectionId ||
        session.request.agent !== request.agent ||
        !hostPathEquals(session.request.workspaceRoot, request.workspaceRoot)
      )
        throw new SkillagerError(
          'invalid-request',
          'Check approved skills again before syncing this library.',
        )
      const current = session
      this.current(current)
      this.available(current.libraryKey)
      if (this.uncertain.has(current.libraryKey))
        throw new SkillagerError(
          'uncertain',
          'Check current state in the original project before another sync.',
        )
      current.ready = false
      const result = await this.run(current, () =>
        this.cli.syncApproved(
          current.grant.selection,
          request.workspaceRoot,
          current.controller.signal,
          () => {
            this.current(current)
            submitted = true
            this.uncertain.set(current.libraryKey, current.contextKey)
          },
        ),
      )
      this.current(current)
      if (
        result.status !== 'uncertain' &&
        !result.items.some((item) => item.recoveryPath)
      )
        this.uncertain.delete(current.libraryKey)
      return { ok: true, value: result }
    } catch (error) {
      if (submitted && session) {
        if (error instanceof SkillagerError && error.reason === 'busy')
          this.uncertain.delete(session.libraryKey)
        else
          return failure(
            new SkillagerError(
              'uncertain',
              'Sync completion could not be verified. Check current state before another sync.',
            ),
          )
      }
      return failure(error)
    } finally {
      if (session) await this.release(session)
    }
  }

  async cancel(owner: RendererOwner, requestId: number): Promise<void> {
    if (!Number.isSafeInteger(requestId) || requestId < 1) return
    const key = ownerKey(owner)
    this.latest.set(key, Math.max(this.latest.get(key) ?? 0, requestId))
    const session = this.sessions.get(key)
    if (session && session.request.requestId <= requestId) await this.release(session)
  }

  async revoke(owner?: RendererOwner): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => !owner || ownerKey(session.owner) === ownerKey(owner))
        .map((session) => this.release(session)),
    )
    if (owner) this.latest.delete(ownerKey(owner))
    else this.latest.clear()
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.revoke()
  }

  private admit(owner: RendererOwner, request: SkillagerRequest): void {
    this.resources.assertCurrent(owner)
    if (this.disposed)
      throw new SkillagerError('cancelled', 'Library sync is unavailable.')
    const key = ownerKey(owner)
    if (
      !Number.isSafeInteger(request.requestId) ||
      request.requestId <= (this.latest.get(key) ?? 0)
    )
      throw new SkillagerError(
        'invalid-request',
        'This library sync request is no longer current.',
      )
    this.latest.set(key, request.requestId)
  }
  private available(libraryKey: string): void {
    if (
      [...this.sessions.values()].some(
        (session) => session.libraryKey === libraryKey && Boolean(session.pending),
      )
    )
      throw new SkillagerError(
        'busy',
        'Wait for the current library sync operation to stop.',
      )
  }
  private current(session: Session): void {
    this.resources.assertCurrent(session.owner)
    session.grant.assertCurrent()
    if (session.revoked || session.controller.signal.aborted || this.disposed)
      throw new SkillagerError('cancelled', 'Library sync request cancelled.')
  }
  private async run<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    this.current(session)
    const timer = setTimeout(
      () => session.controller.abort(),
      SKILLAGER_REQUEST_DEADLINE_MS,
    )
    try {
      const task = operation()
      session.pending = task
      return await task
    } finally {
      session.pending = undefined
      clearTimeout(timer)
    }
  }
  private async release(session: Session): Promise<void> {
    session.revoked = true
    session.ready = false
    session.controller.abort()
    session.lease?.release()
    await session.pending?.catch(() => undefined)
    if (this.sessions.get(ownerKey(session.owner)) === session)
      this.sessions.delete(ownerKey(session.owner))
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}
function failure(error: unknown): SkillagerResult<never> {
  return error instanceof SkillagerError
    ? { ok: false, reason: error.reason, message: error.message }
    : {
        ok: false,
        reason: 'command-failed',
        message: 'The library sync operation could not finish.',
      }
}
