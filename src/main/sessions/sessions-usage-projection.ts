import {
  HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_TOKEN_COUNTER_NAMES,
  type HarnessTelemetry,
  type HarnessUsageValue,
  type SessionsUsageFact,
} from '../../shared'
import {
  sessionsProjectionNonNegativeInteger,
  sessionsProjectionTimestamp,
} from './sessions-projection-values'

/** Removes provider identity, prose, and malformed counters at the main IPC boundary. */
export function sessionsUsageFact(
  telemetry: HarnessTelemetry,
  expectedProviderId: HarnessTelemetry['source']['providerId'],
): SessionsUsageFact {
  if (
    telemetry.version !== 1 ||
    telemetry.source.providerId !== expectedProviderId ||
    !sessionsProjectionTimestamp(telemetry.observedAt)
  ) {
    return { status: 'unavailable', reason: 'source-unavailable' }
  }
  const facet = telemetry.facets.usage
  switch (facet.status) {
    case 'unsupported':
      return { status: 'unsupported' }
    case 'pending':
      return { status: 'pending', reason: 'observation-pending' }
    case 'unavailable':
      return { status: 'unavailable', reason: 'source-unavailable' }
    case 'reset':
      return { status: 'reset', reason: 'source-unavailable' }
    case 'stale': {
      const value = projectedUsageValue(facet.value, true)
      const observedAt = sessionsProjectionTimestamp(facet.observedAt)
        ? facet.observedAt
        : undefined
      return value && observedAt !== undefined
        ? {
            status: 'stale',
            value,
            observedAt,
            reason: 'source-unavailable',
          }
        : { status: 'unavailable', reason: 'source-unavailable' }
    }
    case 'exact': {
      const value = projectedUsageValue(facet.value, true)
      return value && exactUsageValue(value)
        ? { status: 'exact', value, observedAt: telemetry.observedAt }
        : { status: 'unavailable', reason: 'source-unavailable' }
    }
    case 'partial': {
      const value = projectedUsageValue(facet.value, false)
      return value
        ? { status: 'partial', value, observedAt: telemetry.observedAt }
        : { status: 'unavailable', reason: 'source-unavailable' }
    }
  }
}

function projectedUsageValue(
  input: HarnessUsageValue,
  includeNormalizedTotal: boolean,
): HarnessUsageValue | undefined {
  const value: Partial<
    Record<(typeof HARNESS_USAGE_TOKEN_COUNTER_NAMES)[number], number>
  > & {
    normalizedTokenTotal?: number
  } = {}
  for (const name of HARNESS_USAGE_TOKEN_COUNTER_NAMES) {
    const counter = sessionsProjectionNonNegativeInteger(input[name])
    if (counter !== undefined) value[name] = counter
  }
  if (includeNormalizedTotal) {
    const total = sessionsProjectionNonNegativeInteger(input.normalizedTokenTotal)
    if (total !== undefined) value.normalizedTokenTotal = total
  }
  return Object.keys(value).length > 0 ? value : undefined
}

function exactUsageValue(value: HarnessUsageValue): boolean {
  return (
    value.normalizedTokenTotal !== undefined &&
    HARNESS_USAGE_ADDITIVE_TOKEN_COUNTER_NAMES.every((name) => value[name] !== undefined)
  )
}
