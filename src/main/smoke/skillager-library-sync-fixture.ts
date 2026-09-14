import type {
  SkillagerSyncCompletion,
  SkillagerSyncStatus,
} from '../../shared/skillager-library-sync'
import type { SkillagerLibrarySyncCliPort } from '../skillager/skillager-library-sync-port'
import { SkillagerError } from '../skillager/skillager-port'

/** Delayed CLI boundary only; real public subprocess evidence is a separate gate. */
export function skillagerLibrarySyncFixture() {
  let synced = false
  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer)
        reject(new SkillagerError('cancelled', 'Fixture sync cancelled.'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancelled)
        resolve()
      }, 350)
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) cancelled()
    })
  const cli: SkillagerLibrarySyncCliPort = {
    async syncStatus(selection, context, signal): Promise<SkillagerSyncStatus> {
      await wait(signal)
      const count = selection.library?.id === 'onboarding-library' ? 1 : 5000
      return {
        status: 'observed',
        library: selection.library,
        context,
        coverage: {
          discoveredOrigins: count,
          approvedOrigins: count,
          selectedSources: count,
          processedSources: count,
          complete: true,
          discoveryErrors: 0,
        },
        lineages: [],
        candidates: Array.from({ length: count }, (_, index) => ({
          sourceIdentity: `source-${index}`,
          state: 'eligible-create',
        })),
      }
    },
    async syncApproved(
      selection,
      context,
      signal,
      submitted,
    ): Promise<SkillagerSyncCompletion> {
      submitted()
      await wait(signal)
      const empty = selection.library?.id === 'onboarding-library',
        count = empty ? 1 : 5000
      const outcome = empty ? (synced ? 'unchanged' : 'created') : 'skipped'
      if (empty) synced = true
      return {
        status: 'completed',
        library: selection.library,
        context,
        coverage: {
          discoveredOrigins: count,
          approvedOrigins: count,
          selectedSources: count,
          processedSources: count,
          complete: true,
          discoveryErrors: 0,
        },
        counts: {
          created: outcome === 'created' ? 1 : 0,
          updated: 0,
          unchanged: outcome === 'unchanged' ? 1 : 0,
          skipped: outcome === 'skipped' ? count : 0,
          conflict: 0,
          failed: 0,
          uncertain: 0,
        },
        items: Array.from({ length: count }, (_, index) => ({
          sourceIdentity: `source-${index}`,
          originIds: [`origin-${index}`],
          outcome,
          phase: empty ? 'accepted' : 'not-started',
          repair: 'none',
          ...(empty
            ? {
                lineageId: 'fixture-lineage',
                canonicalSkillId: 'lib/skill-1',
                acceptedHash: 'a'.repeat(64),
              }
            : { reason: 'source-unapproved' }),
        })),
      }
    },
  }
  return {
    cli,
    get synced() {
      return synced
    },
  }
}
