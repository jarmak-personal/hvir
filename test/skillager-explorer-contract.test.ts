import { expect, it } from 'vitest'
import { parseSkillagerExposures } from '../src/main/skillager/skillager-cli-metadata'
import { localPath } from '../src/shared/host-path'

const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222'
const root = localPath('/project')
const direct = {
  schema: 'skillager.exposure.v1',
  exposure_id: 'lib-x',
  skill_id: 'lib/x',
  source_library_id: a,
  agent: 'codex',
  scope: 'project',
  target: '/project/.agents/skills/lib-x',
  mode: 'native',
  status: 'current',
}
const router = {
  ...direct,
  exposure_id: 'router',
  skill_id: undefined,
  source_library_id: undefined,
  agent: 'claude',
  target: '/project/.claude/skills/router',
  mode: 'router',
  router_slug: 'router',
  router_kind: 'tag',
  tag: 'tools',
  skill_ids: ['lib/x', 'lib/y'],
  member_sources: [
    { skill_id: 'lib/x', source_library_id: a },
    { skill_id: 'lib/y', source_library_id: b },
  ],
}
function parse(exposures: readonly unknown[], agent: 'all' | 'codex' | 'claude' = 'all') {
  return parseSkillagerExposures(
    { schema: 'skillager.exposures.v1', exposures },
    root,
    agent,
  )
}

it('retains exact agent/source identity and complete router membership from one all-agent result', () => {
  const parsed = parse([direct, router])
  expect(parsed[0]).toMatchObject({
    agent: 'codex',
    sourceLibraryId: a,
    skillId: 'lib/x',
  })
  expect(parsed[1]!.router).toEqual({
    slug: 'router',
    kind: 'tag',
    tag: 'tools',
    skillIds: ['lib/x', 'lib/y'],
    memberSources: [
      { skillId: 'lib/x', sourceLibraryId: a },
      { skillId: 'lib/y', sourceLibraryId: b },
    ],
  })
  expect(() => parse([router], 'codex')).toThrow()
  expect(() => parse([{ ...direct, agent: 'unknown' }])).toThrow()
  expect(() => parse([{ ...direct, target: '/outside/copy' }])).toThrow()
})

it.each([undefined, null, 'malformed', 1, 'ABCDEFAB-1111-4111-8111-111111111111'])(
  'retains a legacy or invalidly qualified direct copy with unknown source: %s',
  (source_library_id) => {
    expect(parse([{ ...direct, source_library_id }])[0]).toMatchObject({
      skillId: 'lib/x',
      agent: 'codex',
      sourceLibraryId: undefined,
    })
  },
)

it.each([
  undefined,
  null,
  [],
  [{ skill_id: 'lib/x', source_library_id: a }],
  [
    { skill_id: 'lib/x', source_library_id: a },
    { skill_id: 'lib/x', source_library_id: a },
  ],
  [
    { skill_id: 'lib/x', source_library_id: a },
    { skill_id: 'lib/outside', source_library_id: b },
  ],
  [{ skill_id: 'lib/x', source_library_id: a }, null],
  [
    { skill_id: 'lib/x', source_library_id: a },
    { skill_id: 'lib/y', source_library_id: 'ABCDEFAB-1111-4111-8111-111111111111' },
  ],
  [
    { skill_id: 'lib/x', source_library_id: a },
    { skill_id: 'lib/y', source_library_id: b, extra: 'PRIVATE' },
  ],
])(
  'never grants partial association from incomplete/malformed member metadata: %j',
  (member_sources) => {
    const result = parse([{ ...router, member_sources }])[0]!
    expect(result.router!.skillIds).toEqual(['lib/x', 'lib/y'])
    expect(result.router!.memberSources).toBeUndefined()
  },
)

it('keeps explicitly null UUID members unassociated and discards unrelated private fields', () => {
  const result = parse([
    {
      ...router,
      private: 'PRIVATE BODY',
      member_sources: [
        { skill_id: 'lib/x', source_library_id: null },
        { skill_id: 'lib/y', source_library_id: null },
      ],
    },
  ])[0]!
  expect(result.router!.memberSources).toEqual([
    { skillId: 'lib/x', sourceLibraryId: undefined },
    { skillId: 'lib/y', sourceLibraryId: undefined },
  ])
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
})

it('rejects duplicate membership IDs before they can become duplicate tree identities', () => {
  expect(() => parse([{ ...router, skill_ids: ['lib/x', 'lib/x'] }])).toThrow(
    'Skillager returned unsupported or malformed metadata.',
  )
  const legacy = parse([{ ...router, member_sources: undefined }])[0]!
  expect(legacy.router!.skillIds).toEqual(['lib/x', 'lib/y'])
  expect(legacy.router!.memberSources).toBeUndefined()
})
