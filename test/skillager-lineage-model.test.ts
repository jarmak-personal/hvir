import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { skillagerLineageIndex } from '../src/renderer/src/skillager/skillager-lineage-model'
import { syncStatus } from './fixtures/skillager-sync-fixture'
import type { SkillagerMetadata } from '../src/shared/skillager'
it('associates canonical copies only by public UUID and original rows by the exact observed source', () => {
  const rows = syncStatus().lineages,
    lookup = skillagerLineageIndex(rows)
  const metadata: SkillagerMetadata = {
    id: 'lib/example',
    name: 'same name',
    description: '',
    trust: 'reviewed',
    source: {
      type: 'collection',
      ownership: 'library',
      libraryId: rows[0]!.canonical.libraryId,
    },
    tags: [],
    matchReasons: [],
    exposure: 'hidden',
  }
  expect(lookup(metadata)).toEqual(rows)
  expect(
    lookup({ ...metadata, source: { ...metadata.source, libraryId: 'other-library' } }),
  ).toEqual([])
  expect(
    lookup({ ...metadata, source: { ...metadata.source, libraryId: undefined } }),
  ).toEqual([])
  const original = {
    ...metadata,
    id: 'project/example',
    source: { type: 'project', ownership: 'external' as const },
    projectSkill: {
      path: localPath('/workspace/.skills/example'),
      agent: 'codex' as const,
      managed: false,
    },
  }
  expect(lookup(original)).toEqual(rows)
  expect(
    lookup({
      ...original,
      projectSkill: {
        ...original.projectSkill,
        path: localPath('/different/.skills/example'),
      },
    }),
  ).toEqual([])
  expect(
    lookup({ ...original, projectSkill: { ...original.projectSkill, agent: 'claude' } }),
  ).toEqual([])
  expect(lookup({ ...metadata, id: 'different' })).toEqual([])
})
