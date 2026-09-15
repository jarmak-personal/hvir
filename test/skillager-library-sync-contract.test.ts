import { describe, expect, it } from 'vitest'
import {
  parseSkillagerSyncStatus,
  parseSkillagerSyncCompletion,
} from '../src/main/skillager/skillager-library-sync-contract'
import {
  syncStatusRaw,
  syncCompletionRaw,
  syncLibrary,
  syncContext,
} from './fixtures/skillager-sync-fixture'
const status = (value: unknown, code = 0) =>
  parseSkillagerSyncStatus(value, code, syncLibrary, syncContext)
const completion = (value: unknown, code = 0) =>
  parseSkillagerSyncCompletion(value, code, syncLibrary, syncContext)

describe('public approved sync projection', () => {
  it('accepts the actual status without top-level status and preserves original/canonical independence', () => {
    const raw = syncStatusRaw()
    raw.lineages[0]!.origins[0]!.observation.status = 'blocked'
    raw.lineages[0]!.origins[0]!.observation.trust = 'blocked'
    raw.lineages[0]!.preservation = 'conflict'
    const result = status({
      ...raw,
      private_record: 'PRIVATE',
      lineages: raw.lineages.map((row) => ({
        ...row,
        source_approval: {
          ...row.source_approval,
          record: 'PRIVATE',
          authority_root: '/private/catalog',
        },
      })),
    })
    expect(result.lineages[0]!).toMatchObject({
      preservation: 'conflict',
      canonical: {
        acceptance: 'accepted',
        trust: 'reviewed',
        reuse: 'all-projects',
        libraryId: syncLibrary.id,
      },
      sourceApproval: { scope: 'project', decisionSkillId: 'project/example' },
      origins: [{ observation: { status: 'blocked' } }],
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|authority_root/)
  })
  it('retains a structured exit-two partial and every accepted/pending outcome', () => {
    const raw = syncCompletionRaw()
    const value = completion(
      {
        ...raw,
        status: 'partial',
        coverage: {
          ...raw.coverage,
          selected_sources: 2,
          processed_sources: 1,
          complete: false,
        },
        counts: { ...raw.counts, skipped: 1 },
        items: [
          ...raw.items,
          {
            source_identity: 'later',
            origin_ids: ['later-origin'],
            outcome: 'skipped',
            phase: 'not-started',
            reason_code: 'time-limit',
            repair: 'none',
          },
        ],
      },
      2,
    )
    expect(value.counts).toMatchObject({ created: 1, skipped: 1 })
    expect(value.items[1]!).toMatchObject({
      outcome: 'skipped',
      reason: 'time-limit',
      phase: 'not-started',
    })
  })
  it('retains nullable structured refusals and actual failed candidates', () => {
    const raw = syncStatusRaw()
    expect(
      status(
        {
          ...raw,
          status: 'refused',
          library: null,
          context: null,
          lineages: [],
          candidates: [],
          reason_code: 'library-changed',
          coverage: {
            discovered_origins: 0,
            approved_origins: 0,
            selected_sources: 0,
            processed_sources: 0,
            complete: false,
            discovery_error_count: 0,
          },
        },
        2,
      ),
    ).toMatchObject({
      status: 'refused',
      library: undefined,
      context: undefined,
      reason: 'library-changed',
    })
    expect(
      status({
        ...raw,
        candidates: [
          { ...raw.candidates[0]!, state: 'failed', reason_code: 'source-missing' },
        ],
      }).candidates[0]!,
    ).toMatchObject({ state: 'failed', reason: 'source-missing' })
  })
  it.each(['uuid', 'root', 'context', 'canonical', 'hash', 'origins', 'counts', 'exit'])(
    'rejects a broken %s binding',
    (kind) => {
      const raw = syncStatusRaw(),
        apply = syncCompletionRaw()
      if (kind === 'uuid') raw.library.library_id = 'other'
      if (kind === 'root') raw.library.root = '/elsewhere'
      if (kind === 'context') raw.context.project_root = '/parent'
      if (kind === 'canonical') raw.lineages[0]!.canonical.path = '/library/skills/other'
      if (kind === 'hash') raw.lineages[0]!.canonical.working_hash = 'b'.repeat(64)
      if (kind === 'origins') raw.lineages[0]!.origins.push(raw.lineages[0]!.origins[0]!)
      if (kind === 'counts') {
        apply.counts.created = 2
        expect(() => completion(apply)).toThrow()
        return
      }
      if (kind === 'exit') {
        expect(() => completion(apply, 2)).toThrow()
        return
      }
      expect(() => status(raw)).toThrow()
    },
  )
  it('rejects combined retained lineage/origin overflow without expanding the consumer bound', () => {
    const raw = syncStatusRaw(),
      row = raw.lineages[0]!,
      origin = row.origins[0]!
    row.origins = Array.from({ length: 10_000 }, (_, index) => ({
      ...origin,
      origin_id: `origin-${index}`,
    }))
    expect(() => status(raw)).toThrow('inventory size')
  })
})
