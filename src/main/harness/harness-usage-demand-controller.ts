import { randomUUID } from 'node:crypto'

import type { HarnessProviderId, HarnessTelemetry, HostPath } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessArtifactContext, HarnessProvider } from './harness-provider-contract'
import type { HarnessProviderRegistry } from './harness-provider-registry'
import { usageStatusHarnessTelemetry } from './harness-usage'

// Reserve shared telemetry-hub capacity for context and other provider facets.
export const MAX_HARNESS_USAGE_DEMAND_TARGETS = 96
export const MAX_HARNESS_USAGE_DEMAND_LEASES = 256
const EXACT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface HarnessUsageDemandTarget {
  /** Opaque exact live-PTY/session generation handle. */
  readonly instanceId: string
  readonly providerId: HarnessProviderId
  readonly host: ProjectHost
  readonly sessionId: string
  readonly cwd: HostPath
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
}

export interface HarnessUsageDemand {
  readonly ownerId: string
  readonly rendererGeneration: number
  readonly demandGeneration: number
  readonly target: HarnessUsageDemandTarget
  readonly emit: (telemetry: HarnessTelemetry) => void
}

interface DemandLease {
  readonly key: string
  readonly ownerId: string
  readonly rendererGeneration: number
  readonly demandGeneration: number
  readonly target: DemandTarget
  readonly emit: (telemetry: HarnessTelemetry) => void
}

interface DemandTarget {
  readonly key: string
  readonly input: HarnessUsageDemandTarget
  readonly provider: HarnessProvider
  readonly controller: AbortController
  readonly leases: Map<string, DemandLease>
  latest: HarnessTelemetry
  queued?: HarnessTelemetry
  flushQueued: boolean
  disposeObserver?: Disposer
  active: boolean
}

/**
 * Main-owned named demand lifetime for cumulative usage observation.
 *
 * The controller does not discover sessions or materialize hosts. Callers must
 * supply one already-qualified live target. Equal targets share one provider
 * observer until their final named lease is released.
 */
export class HarnessUsageDemandController {
  private readonly targetsByHost = new WeakMap<ProjectHost, Map<string, DemandTarget>>()
  private readonly targets = new Set<DemandTarget>()
  private readonly leases = new Map<string, DemandLease>()
  private disposed = false

  constructor(private readonly providers: Pick<HarnessProviderRegistry, 'get'>) {}

  acquire(demand: HarnessUsageDemand): Disposer {
    this.validateDemand(demand)
    if (this.disposed) throw new Error('Harness usage demand controller is disposed')
    this.advanceOwnerGeneration(demand)
    if (this.leases.size >= MAX_HARNESS_USAGE_DEMAND_LEASES) {
      throw new Error(
        `Harness usage demand exceeds ${MAX_HARNESS_USAGE_DEMAND_LEASES} lease limit`,
      )
    }
    const leaseKey = demandLeaseKey(demand)
    if (this.leases.has(leaseKey)) {
      throw new Error('Harness usage demand lease is already active')
    }

    let hostTargets = this.targetsByHost.get(demand.target.host)
    if (!hostTargets) {
      hostTargets = new Map()
      this.targetsByHost.set(demand.target.host, hostTargets)
    }
    const targetKey = demandTargetKey(demand.target)
    let target = hostTargets.get(targetKey)
    if (!target) {
      if (this.targets.size >= MAX_HARNESS_USAGE_DEMAND_TARGETS) {
        throw new Error(
          `Harness usage demand exceeds ${MAX_HARNESS_USAGE_DEMAND_TARGETS} target limit`,
        )
      }
      const provider = this.providers.get(demand.target.providerId)
      target = {
        key: targetKey,
        input: demand.target,
        provider,
        controller: new AbortController(),
        leases: new Map(),
        latest: usageStatusHarnessTelemetry({
          providerId: demand.target.providerId,
          sessionId: demand.target.sessionId,
          provenance: 'Harness usage demand lifecycle',
          usage: provider.usageTelemetry
            ? { status: 'pending', reason: 'Waiting for cumulative usage' }
            : { status: 'unsupported' },
        }),
        flushQueued: false,
        active: true,
      }
      hostTargets.set(targetKey, target)
      this.targets.add(target)
    }

    const lease: DemandLease = {
      key: leaseKey,
      ownerId: demand.ownerId,
      rendererGeneration: demand.rendererGeneration,
      demandGeneration: demand.demandGeneration,
      target,
      emit: demand.emit,
    }
    target.leases.set(leaseKey, lease)
    this.leases.set(leaseKey, lease)
    demand.emit(target.latest)
    if (target.leases.size === 1) this.startTarget(target)

    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseLease(lease)
    }
  }

  releaseOwner(ownerId: string, rendererGeneration?: number): void {
    for (const lease of [...this.leases.values()]) {
      if (
        lease.ownerId === ownerId &&
        (rendererGeneration === undefined ||
          lease.rendererGeneration === rendererGeneration)
      ) {
        this.releaseLease(lease)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const target of [...this.targets]) this.stopTarget(target)
    this.leases.clear()
  }

  private startTarget(target: DemandTarget): void {
    const observer = target.provider.usageTelemetry
    if (!observer) return
    if (target.input.host.connectionState !== 'connected') {
      this.publish(
        target,
        usageStatusHarnessTelemetry({
          providerId: target.input.providerId,
          sessionId: target.input.sessionId,
          provenance: 'Harness usage demand lifecycle',
          usage: { status: 'unavailable', reason: 'host-disconnected' },
        }),
      )
      return
    }
    void Promise.resolve()
      .then(() => {
        if (!target.active || target.controller.signal.aborted) {
          return () => undefined
        }
        return observer.observe(target.input.host, {
          subscriptionId: randomUUID(),
          sessionId: target.input.sessionId,
          cwd: target.input.cwd,
          sessionData: target.input.sessionData,
          artifact: target.input.artifact,
          signal: target.controller.signal,
          emit: (telemetry) => {
            if (telemetry) this.publish(target, telemetry)
          },
        })
      })
      .then(
        (dispose) => {
          if (!target.active || target.controller.signal.aborted) void dispose()
          else target.disposeObserver = dispose
        },
        () => {
          if (!target.active || target.controller.signal.aborted) return
          this.publish(
            target,
            usageStatusHarnessTelemetry({
              providerId: target.input.providerId,
              sessionId: target.input.sessionId,
              provenance: 'Harness usage demand lifecycle',
              usage: { status: 'unavailable', reason: 'usage-observer-unavailable' },
            }),
          )
        },
      )
  }

  private publish(target: DemandTarget, telemetry: HarnessTelemetry): void {
    if (!target.active || target.controller.signal.aborted) return
    target.queued = telemetry
    if (target.flushQueued) return
    target.flushQueued = true
    queueMicrotask(() => {
      target.flushQueued = false
      const next = target.queued
      target.queued = undefined
      if (!next || !target.active || target.controller.signal.aborted) return
      target.latest = next
      for (const lease of target.leases.values()) lease.emit(next)
    })
  }

  private releaseLease(lease: DemandLease): void {
    if (this.leases.get(lease.key) !== lease) return
    this.leases.delete(lease.key)
    lease.target.leases.delete(lease.key)
    if (lease.target.leases.size === 0) this.stopTarget(lease.target)
  }

  private stopTarget(target: DemandTarget): void {
    if (!target.active) return
    target.active = false
    target.queued = undefined
    target.controller.abort()
    void target.disposeObserver?.()
    target.disposeObserver = undefined
    for (const lease of target.leases.values()) this.leases.delete(lease.key)
    target.leases.clear()
    this.targets.delete(target)
    const hostTargets = this.targetsByHost.get(target.input.host)
    if (hostTargets?.get(target.key) === target) hostTargets.delete(target.key)
  }

  private validateDemand(demand: HarnessUsageDemand): void {
    if (
      !boundedIdentity(demand.ownerId) ||
      !boundedIdentity(demand.target.instanceId) ||
      !EXACT_SESSION_ID.test(demand.target.sessionId) ||
      !boundedIdentity(demand.target.artifact.identity) ||
      !positiveGeneration(demand.rendererGeneration) ||
      !positiveGeneration(demand.demandGeneration) ||
      demand.target.cwd.hostId !== demand.target.host.hostId
    ) {
      throw new Error('Harness usage demand is not exactly qualified')
    }
  }

  private advanceOwnerGeneration(demand: HarnessUsageDemand): void {
    const owned = [...this.leases.values()].filter(
      (lease) => lease.ownerId === demand.ownerId,
    )
    const latestRendererGeneration = Math.max(
      0,
      ...owned.map((lease) => lease.rendererGeneration),
    )
    if (demand.rendererGeneration < latestRendererGeneration) {
      throw new Error('Harness usage demand renderer generation is stale')
    }
    if (demand.rendererGeneration > latestRendererGeneration) {
      for (const lease of owned) this.releaseLease(lease)
      return
    }
    const currentRendererLeases = owned.filter(
      (lease) => lease.rendererGeneration === demand.rendererGeneration,
    )
    const latestDemandGeneration = Math.max(
      0,
      ...currentRendererLeases.map((lease) => lease.demandGeneration),
    )
    if (demand.demandGeneration < latestDemandGeneration) {
      throw new Error('Harness usage demand generation is stale')
    }
    if (demand.demandGeneration > latestDemandGeneration) {
      for (const lease of currentRendererLeases) this.releaseLease(lease)
    }
  }
}

function demandLeaseKey(demand: HarnessUsageDemand): string {
  return [
    demand.ownerId,
    demand.rendererGeneration,
    demand.demandGeneration,
    demand.target.instanceId,
  ].join('\0')
}

function demandTargetKey(target: HarnessUsageDemandTarget): string {
  return [
    target.instanceId,
    target.providerId,
    target.sessionId,
    target.artifact.identity,
  ].join('\0')
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 160 && !/[\0\r\n]/.test(value)
}

function positiveGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
