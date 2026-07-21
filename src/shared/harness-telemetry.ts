import type { HarnessProviderId } from './harness-provider'

export type HarnessFacet<T> =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending'; readonly reason?: string }
  | { readonly status: 'unavailable'; readonly reason?: string }
  | { readonly status: 'stale'; readonly value: T; readonly observedAt: number }
  | { readonly status: 'available'; readonly value: T }

export interface HarnessSessionFacet {
  readonly id: string
  readonly state: 'active' | 'waiting' | 'ended' | 'unknown'
}

export interface HarnessModelFacet {
  readonly id: string
  readonly displayName?: string
}

export interface HarnessContextFacet {
  readonly usedTokens: number
  readonly windowTokens?: number
  readonly usedPercent?: number
}

export interface HarnessUsageFacet {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costUsd?: number
}

export interface HarnessTurnFacet {
  readonly state: 'working' | 'waiting-for-user' | 'waiting-for-approval' | 'idle'
  readonly approvalKind?: string
}

export interface HarnessIntegrationsFacet {
  readonly skills?: readonly string[]
  readonly mcpServers?: readonly string[]
}

export interface HarnessSnapshotFacets {
  readonly session: HarnessFacet<HarnessSessionFacet>
  readonly model: HarnessFacet<HarnessModelFacet>
  readonly context: HarnessFacet<HarnessContextFacet>
  readonly usage: HarnessFacet<HarnessUsageFacet>
  readonly turn: HarnessFacet<HarnessTurnFacet>
  readonly integrations: HarnessFacet<HarnessIntegrationsFacet>
}

export type HarnessProviderData =
  | null
  | boolean
  | number
  | string
  | readonly HarnessProviderData[]
  | { readonly [key: string]: HarnessProviderData }

/** Versioned, provenance-carrying foundation for the future harness viewer. */
export interface HarnessSnapshot {
  readonly version: 1
  readonly observedAt: number
  readonly source: {
    readonly providerId: HarnessProviderId
    readonly kind: 'session-artifact' | 'protocol' | 'provider-extension'
    readonly provenance: string
  }
  readonly freshness: {
    readonly state: 'live' | 'stale'
    readonly staleAfterMs: number
  }
  readonly facets: HarnessSnapshotFacets
  readonly providerData?: Readonly<Record<string, HarnessProviderData>>
}

/** Compatibility name for the terminal transport while callers migrate to Snapshot. */
export type HarnessTelemetry = HarnessSnapshot

const MAX_PROVIDER_DATA_BYTES = 64 * 1024
const MAX_PROVIDER_DATA_DEPTH = 8
const MAX_PROVIDER_DATA_ENTRIES = 512

export function boundedHarnessProviderData(
  value: unknown,
): Readonly<Record<string, HarnessProviderData>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  let entries = 0
  const valid = (candidate: unknown, depth: number): candidate is HarnessProviderData => {
    if (depth > MAX_PROVIDER_DATA_DEPTH || ++entries > MAX_PROVIDER_DATA_ENTRIES) {
      return false
    }
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'string'
    ) {
      return typeof candidate !== 'string' || candidate.length <= 4_096
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate)
    if (Array.isArray(candidate)) return candidate.every((item) => valid(item, depth + 1))
    if (!candidate || typeof candidate !== 'object') return false
    return Object.entries(candidate).every(
      ([key, item]) => key.length <= 128 && valid(item, depth + 1),
    )
  }
  if (!valid(value, 0)) return undefined
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PROVIDER_DATA_BYTES
    ) {
      return undefined
    }
  } catch {
    return undefined
  }
  return value as Readonly<Record<string, HarnessProviderData>>
}

export const UNSUPPORTED_HARNESS_FACET = { status: 'unsupported' } as const

export type HarnessContextStatusFacet = Extract<
  HarnessFacet<HarnessContextFacet>,
  { readonly status: 'pending' | 'unavailable' }
>

export function contextHarnessSnapshot(input: {
  readonly providerId: HarnessProviderId
  readonly provenance: string
  readonly context: HarnessContextFacet
  readonly sessionId?: string
  readonly modelId?: string
  readonly observedAt?: number
}): HarnessSnapshot {
  return contextFacetHarnessSnapshot({
    ...input,
    context: { status: 'available', value: input.context },
  })
}

export function contextStatusHarnessSnapshot(input: {
  readonly providerId: HarnessProviderId
  readonly provenance: string
  readonly context: HarnessContextStatusFacet
  readonly sessionId: string
  readonly observedAt?: number
}): HarnessSnapshot {
  return contextFacetHarnessSnapshot(input)
}

function contextFacetHarnessSnapshot(input: {
  readonly providerId: HarnessProviderId
  readonly provenance: string
  readonly context: HarnessFacet<HarnessContextFacet>
  readonly sessionId?: string
  readonly modelId?: string
  readonly observedAt?: number
}): HarnessSnapshot {
  return {
    version: 1,
    observedAt: input.observedAt ?? Date.now(),
    source: {
      providerId: input.providerId,
      kind: 'session-artifact',
      provenance: input.provenance,
    },
    freshness: { state: 'live', staleAfterMs: 30_000 },
    facets: {
      session: input.sessionId
        ? { status: 'available', value: { id: input.sessionId, state: 'active' } }
        : { status: 'unavailable', reason: 'Parser record has no session identity' },
      model: input.modelId
        ? { status: 'available', value: { id: input.modelId } }
        : UNSUPPORTED_HARNESS_FACET,
      context: input.context,
      usage: UNSUPPORTED_HARNESS_FACET,
      turn: UNSUPPORTED_HARNESS_FACET,
      integrations: UNSUPPORTED_HARNESS_FACET,
    },
  }
}
