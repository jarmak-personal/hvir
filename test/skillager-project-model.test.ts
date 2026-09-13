import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { SkillagerMetadata, SkillagerMetadataResult } from '../src/shared/skillager'
import {
  skillagerProjectRows,
  skillagerTabs,
} from '../src/renderer/src/skillager/skillager-model'
import {
  eligibleSkillagerUpdate,
  exposureActions,
} from '../src/renderer/src/skillager/skillager-exposure-model'

const native: SkillagerMetadata = {
  id: 'project/native-guide',
  name: 'Native guide',
  description: 'Project observation',
  source: { type: 'project', ownership: 'external' },
  trust: 'blocked',
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
  projectSkill: {
    path: localPath('/project/.claude/skills/native-guide'),
    agent: 'claude',
    managed: false,
  },
}
const owned: SkillagerMetadata = {
  ...native,
  id: 'lib/guide',
  name: 'Canonical guide',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: 'personal' },
  contentHash: 'a'.repeat(64),
  projectSkill: undefined,
}
const data: SkillagerMetadataResult = {
  rows: [native, owned, { ...owned, id: 'lib/unrelated' }],
  checkedAt: 100,
  durationMs: 1,
  exposures: [
    {
      id: 'copy',
      skillId: owned.id,
      target: localPath('/project/.agents/skills/lib-guide'),
      mode: 'native',
      status: 'source_update',
      expectedSourceHash: owned.contentHash,
    },
  ],
}

it('shows native metadata and one managed copy with actual canonical actions when workspace is browsed first', () => {
  const rows = skillagerProjectRows(data)
  expect(rows.map((row) => row.id)).toEqual([native.id, owned.id])
  expect(rows[0]).toMatchObject({
    source: native.source,
    trust: 'blocked',
    projectSkill: native.projectSkill,
  })
  expect(exposureActions(rows[0]!).every((action) => action.disabled)).toBe(true)
  expect(rows[1]).toMatchObject({
    source: owned.source,
    trust: 'reviewed',
    contentHash: owned.contentHash,
    workspace: data.exposures![0],
  })
  expect(eligibleSkillagerUpdate(rows[1]!)).toBe(true)
  expect(exposureActions(rows[1]!).every((action) => !action.disabled)).toBe(true)
  const tabs = skillagerTabs({ tabs: [] }, { type: 'select', metadata: rows[1]! })
  expect(
    skillagerTabs(tabs, { type: 'observe-project', result: data }).tabs[0]?.metadata,
  ).toEqual(rows[1])
})

it('never infers library authority from a missing canonical source or a matching native id', () => {
  const rows = skillagerProjectRows({ ...data, rows: [{ ...native, id: owned.id }] })
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({
    source: { ownership: 'unknown' },
    trust: 'unknown',
    workspace: data.exposures![0],
  })
  expect(exposureActions(rows[1]!).every((action) => action.disabled)).toBe(true)
  expect(eligibleSkillagerUpdate(rows[1]!)).toBe(false)
})
