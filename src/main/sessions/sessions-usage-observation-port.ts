import {
  MAX_SESSIONS_USAGE_ROWS,
  SESSIONS_PROJECTION_VERSION,
  type SessionsTerminalHandle,
  type SessionsUsageChange,
  type SessionsUsageDemandRequest,
  type SessionsUsageFact,
  type SessionsUsageSnapshot,
} from '../../shared'
import {
  MAX_HARNESS_USAGE_DEMAND_TARGETS,
  type HarnessUsageDemand,
  type HarnessUsageDemandController,
} from '../harness/harness-usage-demand-controller'
import type { Disposer } from '../project-host'
import type { PtyUsageObservationSource } from '../pty/pty-supervisor'
import type { RendererOwner } from '../renderer-resource-scopes'
import type {
  SessionsObservationPort,
  SessionsResolvedUsageTarget,
} from './sessions-observation-port'
import { sessionsUsageFact } from './sessions-usage-projection'

interface UsageLease {
  readonly owner: RendererOwner
  readonly demandGeneration: number
  readonly order: readonly SessionsTerminalHandle[]
  readonly projectionDemandGeneration: number
  readonly targets: SessionsUsageDemandRequest['targets']
  readonly targetFingerprint: string
  readonly facts: Map<SessionsTerminalHandle, SessionsUsageFact>
  readonly releases: Map<SessionsTerminalHandle, Disposer>
  revision: number
  notifyQueued: boolean
  revoked: boolean
}

export interface SessionsUsageObservationPortOptions {
  readonly sessions: Pick<
    SessionsObservationPort,
    'resolveUsageTargets' | 'currentUsageTargets' | 'observeSourceChanges'
  >
  readonly ptys: PtyUsageObservationSource
  readonly usage: Pick<HarnessUsageDemandController, 'acquire'>
  readonly emit: (owner: RendererOwner, change: SessionsUsageChange) => void
  readonly now?: () => number
}

/** Main-owned adapter from safe Sessions qualifiers to #648's exact usage demand. */
export class SessionsUsageObservationPort {
  private readonly leases = new Map<string, UsageLease>()
  private stopObservingSessions?: Disposer
  private disposed = false

  constructor(private readonly options: SessionsUsageObservationPortOptions) {}

  acquire(
    owner: RendererOwner,
    request: SessionsUsageDemandRequest,
  ): SessionsUsageSnapshot {
    this.validateRequest(request)
    if (this.disposed) throw new Error('Sessions usage observation is disposed')
    const key = ownerKey(owner)
    const current = this.leases.get(key)
    if (current?.demandGeneration === request.demandGeneration) {
      return this.snapshot(owner, request.demandGeneration)
    }
    if (current) throw new Error('Sessions usage demand is already active')

    const targets = this.options.sessions.resolveUsageTargets(owner, request)
    const lease: UsageLease = {
      owner,
      demandGeneration: request.demandGeneration,
      order: targets.map((target) => target.handle),
      projectionDemandGeneration: request.projectionDemandGeneration,
      targets: request.targets,
      targetFingerprint: usageTargetsFingerprint(targets),
      facts: new Map(),
      releases: new Map(),
      revision: 1,
      notifyQueued: false,
      revoked: false,
    }
    this.leases.set(key, lease)
    this.startSourceObservation()

    for (const target of targets) {
      this.observeTarget(lease, target, false)
    }
    return this.snapshot(owner, request.demandGeneration)
  }

  snapshot(owner: RendererOwner, demandGeneration: number): SessionsUsageSnapshot {
    const lease = this.leases.get(ownerKey(owner))
    if (!lease || lease.demandGeneration !== demandGeneration) {
      throw new Error('Sessions usage demand is no longer current')
    }
    return {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: lease.revision,
      sampledAt: (this.options.now ?? Date.now)(),
      rows: lease.order.map((handle) => ({
        handle,
        usage:
          lease.facts.get(handle) ??
          ({ status: 'unavailable', reason: 'source-unavailable' } as const),
      })),
    }
  }

  release(owner: RendererOwner, demandGeneration: number): boolean {
    const key = ownerKey(owner)
    const lease = this.leases.get(key)
    if (!lease || lease.demandGeneration !== demandGeneration) return false
    this.leases.delete(key)
    this.stopLease(lease)
    this.stopSourceObservationIfIdle()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.stopObservingSessions?.()
    this.stopObservingSessions = undefined
    for (const lease of this.leases.values()) this.stopLease(lease)
    this.leases.clear()
  }

  private updateFact(
    lease: UsageLease,
    handle: SessionsTerminalHandle,
    usage: SessionsUsageFact,
  ): void {
    if (JSON.stringify(lease.facts.get(handle)) === JSON.stringify(usage)) return
    lease.facts.set(handle, usage)
    lease.revision += 1
    this.queueNotification(lease)
  }

  private reconcileSourceChange(lease: UsageLease): void {
    if (!this.currentLease(lease) || lease.revoked) return
    try {
      const current = this.options.sessions.currentUsageTargets(
        lease.owner,
        lease.projectionDemandGeneration,
        lease.targets,
      )
      if (usageTargetsFingerprint(current) === lease.targetFingerprint) {
        for (const target of current) this.observeTarget(lease, target, true)
        return
      }
    } catch {
      // The exact target disappeared; revoke below.
    }
    lease.revoked = true
    for (const release of [...lease.releases.values()].reverse()) void release()
    lease.releases.clear()
    for (const [handle, fact] of lease.facts) {
      if (fact.status !== 'unsupported') {
        lease.facts.set(handle, {
          status: 'unavailable',
          reason: 'source-unavailable',
        })
      }
    }
    lease.revision += 1
    this.queueNotification(lease)
  }

  private queueNotification(lease: UsageLease): void {
    if (lease.notifyQueued) return
    lease.notifyQueued = true
    queueMicrotask(() => {
      lease.notifyQueued = false
      if (!this.ownsLease(lease)) return
      this.options.emit(lease.owner, {
        demandGeneration: lease.demandGeneration,
        revision: lease.revision,
      })
    })
  }

  private stopLease(lease: UsageLease): void {
    lease.revoked = true
    for (const release of [...lease.releases.values()].reverse()) void release()
    lease.releases.clear()
    lease.facts.clear()
  }

  private startSourceObservation(): void {
    this.stopObservingSessions ??= this.options.sessions.observeSourceChanges(() => {
      for (const lease of this.leases.values()) this.reconcileSourceChange(lease)
    })
  }

  private stopSourceObservationIfIdle(): void {
    if (this.leases.size > 0) return
    void this.stopObservingSessions?.()
    this.stopObservingSessions = undefined
  }

  private observeTarget(
    lease: UsageLease,
    target: SessionsResolvedUsageTarget,
    notify: boolean,
  ): void {
    if (lease.releases.has(target.handle)) return
    const setFact = (usage: SessionsUsageFact): void => {
      if (notify) this.updateFact(lease, target.handle, usage)
      else lease.facts.set(target.handle, usage)
    }
    if (!target.usageSupported) return setFact({ status: 'unsupported' })
    if (target.connectionState !== 'connected') {
      return setFact({ status: 'unavailable', reason: 'connection-unavailable' })
    }
    if (!target.livePty) {
      return setFact({ status: 'unavailable', reason: 'not-live' })
    }
    if (lease.releases.size >= MAX_HARNESS_USAGE_DEMAND_TARGETS) {
      return setFact({ status: 'unavailable', reason: 'observation-capacity' })
    }
    const resolution = this.options.ptys.resolveUsageObservation(
      String(target.handle),
      String(target.livePty.handle),
    )
    if (resolution.status !== 'available') {
      return setFact(
        resolution.status === 'pending'
          ? { status: 'pending', reason: 'identity-pending' }
          : { status: 'unavailable', reason: 'identity-unavailable' },
      )
    }
    if (resolution.target.providerId !== target.providerId) {
      return setFact({ status: 'unavailable', reason: 'source-unavailable' })
    }
    setFact({ status: 'pending', reason: 'observation-pending' })
    try {
      const demand: HarnessUsageDemand = {
        ownerId: `sessions-usage:${lease.owner.id}`,
        rendererGeneration: lease.owner.generation,
        demandGeneration: lease.demandGeneration,
        target: resolution.target,
        emit: (telemetry) => {
          if (this.currentLease(lease)) {
            this.updateFact(
              lease,
              target.handle,
              sessionsUsageFact(telemetry, target.providerId),
            )
          }
        },
      }
      lease.releases.set(target.handle, this.options.usage.acquire(demand))
    } catch {
      setFact({ status: 'unavailable', reason: 'source-unavailable' })
    }
  }

  private currentLease(lease: UsageLease): boolean {
    return !lease.revoked && this.ownsLease(lease)
  }

  private ownsLease(lease: UsageLease): boolean {
    return !this.disposed && this.leases.get(ownerKey(lease.owner)) === lease
  }

  private validateRequest(request: SessionsUsageDemandRequest): void {
    if (
      !positiveGeneration(request.demandGeneration) ||
      !positiveGeneration(request.projectionDemandGeneration) ||
      !Number.isSafeInteger(request.sourceRevision) ||
      request.sourceRevision <= 0 ||
      request.targets.length > MAX_SESSIONS_USAGE_ROWS
    ) {
      throw new Error('Invalid Sessions usage demand')
    }
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function positiveGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function usageTargetsFingerprint(
  targets: readonly {
    readonly handle: SessionsTerminalHandle
    readonly livePty?: {
      readonly handle: string
      readonly rendererOwnerId: number
      readonly rendererGeneration: number
    }
    readonly providerId?: string
    readonly usageSupported?: boolean
    readonly connectionState?: string
  }[],
): string {
  return JSON.stringify(
    targets.map((target) => [
      target.handle,
      target.livePty?.handle,
      target.livePty?.rendererOwnerId,
      target.livePty?.rendererGeneration,
      target.providerId,
      target.usageSupported,
      target.connectionState,
    ]),
  )
}
