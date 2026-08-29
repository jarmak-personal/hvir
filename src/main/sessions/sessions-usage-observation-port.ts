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
  order: readonly SessionsTerminalHandle[]
  readonly projectionDemandGeneration: number
  targets: SessionsUsageDemandRequest['targets']
  readonly targetFingerprints: Map<SessionsTerminalHandle, string>
  readonly targetEpochs: Map<SessionsTerminalHandle, number>
  readonly facts: Map<SessionsTerminalHandle, SessionsUsageFact>
  readonly releases: Map<SessionsTerminalHandle, Disposer>
  revision: number
  notifyQueued: boolean
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
      const targets = this.options.sessions.resolveUsageTargets(owner, request)
      this.reconcileRequest(current, request, targets)
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
      targetFingerprints: new Map(),
      targetEpochs: new Map(),
      facts: new Map(),
      releases: new Map(),
      revision: 1,
      notifyQueued: false,
    }
    this.leases.set(key, lease)
    this.startSourceObservation()

    for (const target of targets) this.reconcileTarget(lease, target, false)
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
    if (!this.currentLease(lease)) return
    for (const target of lease.targets) {
      try {
        const current = this.options.sessions.currentUsageTargets(
          lease.owner,
          lease.projectionDemandGeneration,
          [target],
        )[0]
        if (!current) throw new Error('Sessions usage target is unavailable')
        this.reconcileTarget(lease, current, true)
      } catch {
        this.stopTarget(lease, target.handle)
        this.updateFact(lease, target.handle, {
          status: 'unavailable',
          reason: 'source-unavailable',
        })
      }
    }
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
    for (const handle of lease.order) this.stopTarget(lease, handle)
    lease.facts.clear()
    lease.targetFingerprints.clear()
    lease.targetEpochs.clear()
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
    const epoch = (lease.targetEpochs.get(target.handle) ?? 0) + 1
    lease.targetEpochs.set(target.handle, epoch)
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
          if (
            this.currentLease(lease) &&
            lease.targetEpochs.get(target.handle) === epoch
          ) {
            this.updateFact(
              lease,
              target.handle,
              sessionsUsageFact(telemetry, target.providerId),
            )
          }
        },
      }
      const release = this.options.usage.acquire(demand)
      if (this.currentLease(lease) && lease.targetEpochs.get(target.handle) === epoch) {
        lease.releases.set(target.handle, release)
      } else {
        void release()
      }
    } catch {
      setFact({ status: 'unavailable', reason: 'source-unavailable' })
    }
  }

  private currentLease(lease: UsageLease): boolean {
    return this.ownsLease(lease)
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

  private reconcileRequest(
    lease: UsageLease,
    request: SessionsUsageDemandRequest,
    targets: readonly SessionsResolvedUsageTarget[],
  ): void {
    if (lease.projectionDemandGeneration !== request.projectionDemandGeneration) {
      throw new Error('Sessions usage projection demand changed')
    }
    const nextHandles = new Set(targets.map((target) => target.handle))
    const orderChanged =
      targets.length !== lease.order.length ||
      targets.some((target, index) => lease.order[index] !== target.handle)
    for (const handle of lease.order) {
      if (nextHandles.has(handle)) continue
      this.stopTarget(lease, handle)
      lease.facts.delete(handle)
      lease.targetFingerprints.delete(handle)
      lease.targetEpochs.delete(handle)
    }
    lease.order = targets.map((target) => target.handle)
    lease.targets = request.targets
    for (const target of targets) this.reconcileTarget(lease, target, false)
    if (orderChanged) lease.revision += 1
  }

  private reconcileTarget(
    lease: UsageLease,
    target: SessionsResolvedUsageTarget,
    notify: boolean,
  ): void {
    const fingerprint = usageTargetFingerprint(target)
    if (lease.targetFingerprints.get(target.handle) === fingerprint) {
      this.observeTarget(lease, target, notify)
      return
    }
    this.stopTarget(lease, target.handle)
    lease.targetFingerprints.set(target.handle, fingerprint)
    this.observeTarget(lease, target, notify)
  }

  private stopTarget(lease: UsageLease, handle: SessionsTerminalHandle): void {
    lease.targetEpochs.set(handle, (lease.targetEpochs.get(handle) ?? 0) + 1)
    const release = lease.releases.get(handle)
    lease.releases.delete(handle)
    void release?.()
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function positiveGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function usageTargetFingerprint(target: SessionsResolvedUsageTarget): string {
  return JSON.stringify([
    target.livePty?.handle,
    target.livePty?.rendererOwnerId,
    target.livePty?.rendererGeneration,
    target.providerId,
    target.usageSupported,
    target.connectionState,
  ])
}
