import type {
  SkillagerSyncCompletion,
  SkillagerSyncStatus,
} from '../../shared/skillager-library-sync'
import type { SkillagerLibrarySyncCliPort } from '../skillager/skillager-library-sync-port'
import {
  SkillagerError,
  SKILLAGER_REQUEST_DEADLINE_MS,
} from '../skillager/skillager-port'

export interface SkillagerSyncApplyHold {
  readonly submitted: Promise<boolean>
  release(): void
}
interface PendingApply extends SkillagerSyncApplyHold {
  readonly ready: Promise<void>
  start(): void
}

/** Delayed CLI boundary only; real public subprocess evidence is a separate gate. */
export function skillagerLibrarySyncFixture() {
  let synced = false
  let nextApply: PendingApply | undefined
  const wait = (signal: AbortSignal, hold?: PendingApply) =>
    new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelled)
        hold?.release()
        reject(new SkillagerError('cancelled', 'Fixture sync cancelled.'))
      }
      const finish = () => {
        signal.removeEventListener('abort', cancelled)
        resolve()
      }
      const timer = hold ? undefined : setTimeout(finish, 350)
      if (hold) void hold.ready.then(finish)
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
      const hold = nextApply
      nextApply = undefined
      submitted()
      hold?.start()
      await wait(signal, hold)
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
    holdNextApply(): SkillagerSyncApplyHold {
      if (nextApply) throw Error('A fixture sync is already held')
      let resume!: () => void
      let acknowledge!: (submitted: boolean) => void
      const ready = new Promise<void>((resolve) => {
        resume = resolve
      })
      const submitted = new Promise<boolean>((resolve) => {
        acknowledge = resolve
      })
      const held: PendingApply = {
        ready,
        submitted,
        start() {
          clearTimeout(timer)
          acknowledge(true)
        },
        release() {
          clearTimeout(timer)
          if (nextApply === held) nextApply = undefined
          acknowledge(false)
          resume()
        },
      }
      const timer = setTimeout(() => held.release(), SKILLAGER_REQUEST_DEADLINE_MS)
      nextApply = held
      return held
    },
    get synced() {
      return synced
    },
  }
}
