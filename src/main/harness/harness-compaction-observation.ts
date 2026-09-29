import type { HarnessCompactionFacet, HarnessFacet, HarnessTelemetry } from '../../shared'
import type { ProjectHost } from '../project-host'

const MAX_REPLAY_IDENTITIES = 512
const MAX_RETAINED_CONVERSATIONS_PER_HOST = 512

export interface CompletedHarnessCompaction {
  readonly identity: string
  readonly observedAt: number
}

/** Provider-owned running-app count layered onto the provider's latest telemetry. */
export class HarnessCompactionObservation {
  private readonly periodStartedAt: number
  private readonly identities = new Set<string>()
  private readonly identityOrder: string[] = []
  private observedCount = 0
  private lastObservedAt?: number
  private coverage: HarnessCompactionFacet['coverage'] = 'continuous'

  constructor(
    private readonly supported: boolean,
    now: () => number = Date.now,
  ) {
    this.periodStartedAt = now()
  }

  merge(telemetry: HarnessTelemetry): HarnessTelemetry {
    return {
      ...telemetry,
      facets: { ...telemetry.facets, compactions: this.facet() },
    }
  }

  accept(
    telemetry: HarnessTelemetry,
    record: CompletedHarnessCompaction,
  ): HarnessTelemetry | undefined {
    if (
      !this.supported ||
      !boundedIdentity(record.identity) ||
      !validTimestamp(record.observedAt) ||
      record.observedAt < this.periodStartedAt ||
      this.identities.has(record.identity)
    ) {
      return undefined
    }
    this.identities.add(record.identity)
    this.identityOrder.push(record.identity)
    if (this.identityOrder.length > MAX_REPLAY_IDENTITIES) {
      this.identities.delete(this.identityOrder.shift()!)
    }
    this.observedCount += 1
    this.lastObservedAt = Math.max(this.lastObservedAt ?? 0, record.observedAt)
    return this.merge({
      ...telemetry,
      observedAt: Math.max(telemetry.observedAt, record.observedAt),
      facets: {
        ...telemetry.facets,
        context: {
          status: 'pending',
          reason: 'Waiting for post-compaction context telemetry',
        },
      },
    })
  }

  gap(telemetry: HarnessTelemetry): HarnessTelemetry {
    this.noteGap()
    return this.merge(telemetry)
  }

  noteGap(): void {
    if (this.supported) this.coverage = 'gapped'
  }

  private facet(): HarnessFacet<HarnessCompactionFacet> {
    if (!this.supported) return { status: 'unsupported' }
    return {
      status: 'available',
      value: {
        observedCount: this.observedCount,
        periodStartedAt: this.periodStartedAt,
        ...(this.lastObservedAt === undefined
          ? {}
          : { lastObservedAt: this.lastObservedAt }),
        coverage: this.coverage,
      },
    }
  }
}

/**
 * Running-app retention for one exact host/provider artifact conversation.
 *
 * Provider adapters own one registry. Reacquiring an identity preserves the
 * known total while conservatively recording the unobserved interval as a gap.
 */
export class HarnessCompactionObservationRegistry {
  private readonly byHost = new WeakMap<
    ProjectHost,
    Map<string, HarnessCompactionObservation>
  >()

  acquire(
    host: ProjectHost,
    artifactIdentity: string,
    sessionId: string,
    supported: boolean,
  ): HarnessCompactionObservation {
    let conversations = this.byHost.get(host)
    if (!conversations) {
      conversations = new Map()
      this.byHost.set(host, conversations)
    }
    const key = `${artifactIdentity}\0${sessionId}\0${supported ? 'supported' : 'unsupported'}`
    const retained = conversations.get(key)
    if (retained) {
      // Refresh insertion order so bounded eviction prefers dormant identities.
      conversations.delete(key)
      conversations.set(key, retained)
      retained.noteGap()
      return retained
    }
    const created = new HarnessCompactionObservation(supported)
    conversations.set(key, created)
    while (conversations.size > MAX_RETAINED_CONVERSATIONS_PER_HOST) {
      const oldest = conversations.keys().next().value
      if (oldest === undefined) break
      conversations.delete(oldest)
    }
    return created
  }
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value)
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
