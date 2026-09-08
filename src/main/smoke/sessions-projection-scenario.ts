import { verifySessionsProjectionSmoke } from './sessions-projection'
import type { SmokeRendererReadiness } from './renderer-readiness-observer'

export function verifySessionsProjectionScenario(
  options: Omit<
    Parameters<typeof verifySessionsProjectionSmoke>[0],
    'replacementReady'
  > & {
    readonly readiness: SmokeRendererReadiness
  },
): Promise<string> {
  const { readiness, ...projection } = options
  return readiness.withReplacement(projection.initialOwner, (replacementReady) =>
    verifySessionsProjectionSmoke({ ...projection, replacementReady }),
  )
}
