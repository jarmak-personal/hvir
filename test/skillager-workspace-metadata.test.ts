import { expect, it } from 'vitest'
import { skillagerSourceKey } from '../src/shared/skillager-source-identity'
import { localPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import { withSkillagerRouterMemberships } from '../src/main/skillager/skillager-workspace-metadata'
import { skillagerWorkspaceMetadata } from '../src/renderer/src/skillager/skillager-model'

const row: SkillagerMetadata = {
  id: 'lib/x',
  name: 'X',
  description: '',
  source: { type: 'collection', ownership: 'library', libraryId: 'library-a' },
  trust: 'discovered',
  contentHash: 'b'.repeat(64),
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const router: SkillagerWorkspaceExposure = {
  id: 'router',
  agent: 'codex',
  mode: 'router',
  status: 'source_update',
  target: localPath('/project/router'),
  router: {
    slug: 'router',
    kind: 'group',
    skillIds: [row.id],
    memberSources: [{ skillId: row.id, sourceLibraryId: 'library-a' }],
  },
}

it('counts proven multi-agent router presence independently of changed source bytes and direct copies', () => {
  const exposures = [
    router,
    {
      ...router,
      id: 'claude-router',
      agent: 'claude' as const,
      target: localPath('/project/claude-router'),
    },
  ]
  const rows = withSkillagerRouterMemberships([row], exposures)
  expect(rows[0]!.workspaceRouterCount).toBe(2)
  expect(rows[0]!.trust).toBe('discovered')
  const observed = skillagerWorkspaceMetadata({
    rows,
    exposures,
    checkedAt: 1,
    durationMs: 1,
  })[0]!
  expect(observed.exposure).toBe('project')
  expect(observed.workspaceCopies).toEqual([])
})

it('excludes foreign, unknown and unreturned members, and distinguishes unavailable from observed zero', () => {
  const foreign = { ...row, source: { ...row.source, libraryId: 'library-b' } }
  expect(
    withSkillagerRouterMemberships([foreign], [router])[0]!.workspaceRouterCount,
  ).toBe(0)
  const unknown = {
    ...router,
    router: { ...router.router!, memberSources: [{ skillId: row.id }] },
  }
  expect(withSkillagerRouterMemberships([row], [unknown])[0]!.workspaceRouterCount).toBe(
    0,
  )
  expect(
    withSkillagerRouterMemberships([row], undefined)[0]!.workspaceRouterCount,
  ).toBeUndefined()
  expect(withSkillagerRouterMemberships([row], [router])).toHaveLength(1)
  const native = { ...row, source: { type: 'project', ownership: 'external' as const } }
  expect(withSkillagerRouterMemberships([native], [router])[0]).toBe(native)
})

it('uses one exact qualified identity and never associates a missing UUID with another unqualified source', () => {
  expect(skillagerSourceKey('library-a', 'lib/x')).not.toBe(
    skillagerSourceKey('library-b', 'lib/x'),
  )
  expect(skillagerSourceKey(undefined, 'lib/x')).toBeUndefined()
  expect(skillagerSourceKey('', 'lib/x')).toBeUndefined()
  expect(skillagerSourceKey('library-a', undefined)).toBeUndefined()
  const missing = { ...row, source: { ...row.source, libraryId: undefined } }
  const unknown = {
    ...router,
    router: { ...router.router!, memberSources: [{ skillId: row.id }] },
  }
  expect(
    withSkillagerRouterMemberships([missing], [unknown])[0]!.workspaceRouterCount,
  ).toBeUndefined()
  expect(
    skillagerWorkspaceMetadata({
      rows: [missing],
      exposures: [{ ...router, router: undefined, skillId: row.id }],
      checkedAt: 1,
      durationMs: 1,
    })[0]!.workspaceCopies,
  ).toEqual([])
})
