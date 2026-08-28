import type { HarnessContextPressurePolicy, HarnessTelemetry } from '../../../shared'
import { ProviderContextMeter } from '../harness/ProviderContextMeter'

export function TerminalContextMeter({
  telemetry,
  countOnly = false,
  pressurePolicy,
}: {
  readonly telemetry?: HarnessTelemetry
  readonly countOnly?: boolean
  readonly pressurePolicy?: HarnessContextPressurePolicy
}) {
  const contextFacet = telemetry?.facets.context
  return (
    <ProviderContextMeter
      contextFacet={contextFacet}
      countOnly={countOnly}
      pressurePolicy={pressurePolicy}
    />
  )
}
