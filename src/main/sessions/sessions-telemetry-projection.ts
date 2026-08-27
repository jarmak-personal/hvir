import {
  sessionsProjectionOptionalText,
  type HarnessFacet,
  type HarnessModelFacet,
  type HarnessContextFacet,
  type HarnessTelemetry,
  type HarnessTurnFacet,
  type HostConnectionState,
  type SessionsContextFact,
  type SessionsFact,
  type SessionsModelFact,
  type SessionsProviderProjection,
  type SessionsTelemetryFacts,
  type SessionsTurnFact,
} from '../../shared'
import {
  sessionsProjectionNonNegativeInteger,
  sessionsProjectionPercent,
  sessionsProjectionTimestamp,
} from './sessions-projection-values'

export function sessionsTelemetryFacts(
  supported: boolean,
  live: boolean,
  telemetry: HarnessTelemetry | undefined,
  providerId: SessionsProviderProjection['id'],
  connectionState: HostConnectionState,
): SessionsTelemetryFacts {
  if (!supported) return unsupportedTelemetry()
  if (!live) return unavailableTelemetry('not-live')
  if (!telemetry) return pendingTelemetry()
  if (
    telemetry.version !== 1 ||
    telemetry.source.providerId !== providerId ||
    !sessionsProjectionTimestamp(telemetry.observedAt)
  ) {
    return unavailableTelemetry('source-unavailable')
  }
  const observedAt = telemetry.observedAt
  const disconnected = connectionState !== 'connected'
  const stale = disconnected || telemetry.freshness.state === 'stale'
  const reason = disconnected ? 'connection-unavailable' : 'source-stale'
  return {
    model: projectFacet(telemetry.facets.model, observedAt, stale, reason, sanitizeModel),
    context: projectFacet(
      telemetry.facets.context,
      observedAt,
      stale,
      reason,
      sanitizeContext,
    ),
    turn: projectFacet(telemetry.facets.turn, observedAt, stale, reason, sanitizeTurn),
    freshness:
      sessionsProjectionNonNegativeInteger(telemetry.freshness.staleAfterMs) !== undefined
        ? stale
          ? {
              status: 'stale',
              value: { staleAfterMs: telemetry.freshness.staleAfterMs },
              observedAt,
              reason,
            }
          : {
              status: 'available',
              value: { staleAfterMs: telemetry.freshness.staleAfterMs },
              observedAt,
            }
        : { status: 'unavailable', reason: 'source-unavailable' },
  }
}

function projectFacet<TSource, TProjected>(
  facet: HarnessFacet<TSource>,
  snapshotObservedAt: number,
  forceStale: boolean,
  staleReason: 'connection-unavailable' | 'source-stale',
  project: (value: TSource) => TProjected | undefined,
): SessionsFact<TProjected> {
  if (facet.status === 'unsupported') return { status: 'unsupported' }
  if (facet.status === 'pending') {
    return { status: 'pending', reason: 'telemetry-pending' }
  }
  if (facet.status === 'unavailable') {
    return { status: 'unavailable', reason: 'source-unavailable' }
  }
  const value = project(facet.value)
  if (!value) return { status: 'unavailable', reason: 'source-unavailable' }
  const observedAt =
    facet.status === 'stale' && sessionsProjectionTimestamp(facet.observedAt)
      ? facet.observedAt
      : snapshotObservedAt
  if (forceStale || facet.status === 'stale') {
    return {
      status: 'stale',
      value,
      observedAt,
      reason: forceStale ? staleReason : 'source-stale',
    }
  }
  return { status: 'available', value, observedAt }
}

function sanitizeModel(value: HarnessModelFacet): SessionsModelFact | undefined {
  const id = sessionsProjectionOptionalText(value.id, 256)
  if (!id) return undefined
  const displayName = sessionsProjectionOptionalText(value.displayName, 256)
  return displayName ? { id, displayName } : { id }
}

function sanitizeContext(value: HarnessContextFacet): SessionsContextFact | undefined {
  const usedTokens = sessionsProjectionNonNegativeInteger(value.usedTokens)
  const windowTokens = sessionsProjectionNonNegativeInteger(value.windowTokens)
  const usedPercent = sessionsProjectionPercent(value.usedPercent)
  if (usedTokens === undefined) return undefined
  return {
    usedTokens,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
  }
}

function sanitizeTurn(value: HarnessTurnFacet): SessionsTurnFact | undefined {
  switch (value.state) {
    case 'working':
    case 'waiting-for-user':
    case 'waiting-for-approval':
    case 'idle':
      return { state: value.state }
  }
}

function unsupportedTelemetry(): SessionsTelemetryFacts {
  return {
    model: { status: 'unsupported' },
    context: { status: 'unsupported' },
    turn: { status: 'unsupported' },
    freshness: { status: 'unsupported' },
  }
}

function pendingTelemetry(): SessionsTelemetryFacts {
  return {
    model: { status: 'pending', reason: 'telemetry-pending' },
    context: { status: 'pending', reason: 'telemetry-pending' },
    turn: { status: 'pending', reason: 'telemetry-pending' },
    freshness: { status: 'pending', reason: 'telemetry-pending' },
  }
}

function unavailableTelemetry(
  reason: 'not-live' | 'source-unavailable',
): SessionsTelemetryFacts {
  return {
    model: { status: 'unavailable', reason },
    context: { status: 'unavailable', reason },
    turn: { status: 'unavailable', reason },
    freshness: { status: 'unavailable', reason },
  }
}
