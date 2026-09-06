import { verifyRendererProcessRecovery } from './renderer-recovery'
import type { SmokeRendererReadiness } from './renderer-readiness-observer'

export async function verifyRendererRecoveryScenario(
  options: Omit<
    Parameters<typeof verifyRendererProcessRecovery>[0],
    'replacementReady'
  > & {
    readonly readiness: SmokeRendererReadiness
    readonly discardedGenerations: () => number
  },
): Promise<string> {
  const { readiness, discardedGenerations, ...recovery } = options
  return readiness.withReplacement(
    recovery.resources.currentOwner(recovery.win.webContents.id),
    async (replacementReady) => {
      const result = await verifyRendererProcessRecovery({
        ...recovery,
        replacementReady,
      })
      if (discardedGenerations() !== 1) {
        throw new Error(
          `renderer recovery discarded resources ${discardedGenerations()} times`,
        )
      }
      return result
    },
  )
}
