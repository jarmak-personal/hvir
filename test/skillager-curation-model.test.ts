import { describe, expect, it } from 'vitest'
import { isNativeProjectSkill } from '../src/renderer/src/skillager/skillager-model'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import { skillagerNativeSelector } from '../src/renderer/src/skillager/skillager-native-selection'
import {
  curationChoice,
  curationPlan,
  curationMembers,
} from '../src/renderer/src/skillager/skillager-curation-model'
import { exposureActions } from '../src/renderer/src/skillager/skillager-exposure-model'
import { syncContext, syncLibrary, syncStatus } from './fixtures/skillager-sync-fixture'

const native: SkillagerMetadata = {
  id: 'project/example',
  name: 'Example',
  description: '',
  trust: 'reviewed',
  source: { type: 'project', ownership: 'external' },
  tags: [],
  matchReasons: [],
  exposure: 'native',
  projectSkill: {
    path: localPath('/workspace/.skills/example'),
    agent: 'codex',
    managed: false,
  },
}
const destination = { projectId: 'project', workspaceId: 'workspace', root: syncContext }
const router: SkillagerWorkspaceExposure = {
  id: 'router-guidance',
  agent: 'codex',
  target: localPath('/workspace/.agents/skills/router-guidance'),
  mode: 'router',
  status: 'current',
  router: {
    kind: 'tag',
    slug: 'router-guidance',
    tag: 'guidance',
    skillIds: ['lib/example', 'lib/second'],
    memberSources: [
      { skillId: 'lib/example', sourceLibraryId: syncLibrary.id },
      { skillId: 'lib/second', sourceLibraryId: syncLibrary.id },
    ],
  },
}
const member: SkillagerMetadata = {
  ...native,
  id: 'lib/example',
  source: { type: 'collection', ownership: 'library', libraryId: syncLibrary.id },
  projectSkill: undefined,
  routerMembership: router,
}

describe('exact native occurrence selection and project curation', () => {
  it('selects the observed occurrence without deriving identities and keeps native conversion separate from library provenance', () => {
    const report = syncStatus(),
      selected = skillagerNativeSelector(report, syncContext, syncLibrary.id)(native)
    expect(selected).toEqual({
      originId: 'origin',
      lineageId: 'lineage',
      sourceIdentity: 'source',
      skillId: 'lib/example',
      path: native.projectSkill!.path,
    })
    const choice = curationChoice(native, report, destination, syncLibrary.id)
    expect(
      curationPlan(native, 'stub', 'stub', choice, destination, 'codex', syncLibrary.id, [
        native,
      ]),
    ).toEqual({
      plan: {
        schema: 'skillager.exposure-request.v1',
        action: 'adopt-native',
        origin_id: 'origin',
        source: { library_id: syncLibrary.id, skill_id: 'lib/example' },
        mode: 'stub',
      },
      origins: [selected],
      exposures: [],
    })
  })
  it.each([
    'duplicate',
    'path',
    'agent',
    'project',
    'library',
    'changed',
    'incomplete',
    'unpreserved',
  ] as const)(
    'refuses %s native evidence instead of borrowing a canonical match',
    (kind) => {
      const report = syncStatus(),
        lineage = report.lineages[0]!,
        origin = lineage.origins[0]!
      const changed =
        kind === 'duplicate'
          ? { ...report, lineages: [...report.lineages, lineage] }
          : kind === 'incomplete'
            ? { ...report, coverage: { ...report.coverage, complete: false } }
            : kind === 'library'
              ? { ...report, library: { ...report.library!, id: 'foreign' } }
              : kind === 'project'
                ? { ...report, context: localPath('/other') }
                : {
                    ...report,
                    lineages: [
                      {
                        ...lineage,
                        preservation:
                          kind === 'unpreserved'
                            ? ('pending' as const)
                            : lineage.preservation,
                        origins: [
                          {
                            ...origin,
                            path:
                              kind === 'path'
                                ? localPath('/workspace/.skills/other')
                                : origin.path,
                            native:
                              kind === 'agent'
                                ? { ...origin.native!, agent: 'claude' as const }
                                : origin.native,
                            observation:
                              kind === 'changed'
                                ? { ...origin.observation, status: 'changed' as const }
                                : origin.observation,
                          },
                        ],
                      },
                    ],
                  }
      expect(
        skillagerNativeSelector(changed, syncContext, syncLibrary.id)(native),
      ).toBeUndefined()
    },
  )
  it('offers pending originals an independent Files handoff without approving or constructing a removal plan', () => {
    const pending = { ...native, trust: 'blocked' as const }
    expect(
      exposureActions(pending, false, syncLibrary.id)
        .filter((item) => !item.disabled)
        .map((item) => item.action),
    ).toEqual(['files'])
    expect(() =>
      curationPlan(
        pending,
        'remove',
        'native',
        curationChoice(pending),
        destination,
        'codex',
        syncLibrary.id,
        [pending],
      ),
    ).toThrow('no exact approved preserved library relation')
  })
  it('requires an explicit outcome for every departure and preserves unselected standalone copies', () => {
    const row = { ...member, routerMembership: undefined, workspace: router },
      choice = { ...curationChoice(row), members: ['lib/second'] }
    expect(() =>
      curationPlan(
        row,
        'edit-members',
        'native',
        choice,
        destination,
        'codex',
        syncLibrary.id,
        [],
      ),
    ).toThrow('every departing member')
    const plan = curationPlan(
      row,
      'edit-members',
      'native',
      { ...choice, departures: { 'lib/example': 'remove' } },
      destination,
      'codex',
      syncLibrary.id,
      [],
    )
    expect(plan.plan).toMatchObject({
      action: 'set-members',
      members: ['lib/second'],
      replace: [],
      departures: [{ skill_id: 'lib/example', mode: 'remove' }],
    })
    expect(plan.exposures).toEqual([router])
  })
  it.each(['full', 'stub', 'remove'] as const)(
    'a member %s action changes that membership without silently removing other copies',
    (action) => {
      const plan = curationPlan(
        member,
        action,
        action === 'stub' ? 'stub' : 'native',
        curationChoice(member),
        destination,
        'codex',
        syncLibrary.id,
        [],
      )
      expect(plan.plan).toMatchObject({
        action: 'set-members',
        router_id: router.id,
        members: ['lib/second'],
        replace: [],
        departures: [
          {
            skill_id: member.id,
            mode: action === 'remove' ? 'remove' : action === 'stub' ? 'stub' : 'native',
          },
        ],
      })
    },
  )
  it('clears only the replacement tied to a deliberately deselected member', () => {
    const choice = {
      ...curationChoice(member),
      replacements: ['exposure:first', 'origin:second', 'vanished'],
    }
    expect(
      curationMembers(
        choice,
        ['lib/second'],
        [
          { key: 'exposure:first', skillId: 'lib/example', label: 'First' },
          { key: 'origin:second', skillId: 'lib/second', label: 'Second' },
        ],
      ).replacements,
    ).toEqual(['origin:second', 'vanished'])
  })
  it('indexes 5,000 public origins once, then resolves every native row without rescanning lineage arrays', () => {
    const report = syncStatus(),
      base = report.lineages[0]!,
      original = base.origins[0]!
    let reads = 0
    const lineages = Array.from({ length: 5000 }, (_, i) => ({
      ...base,
      id: `lineage-${i}`,
      canonical: { ...base.canonical, skillId: `lib/item-${i}` },
      get origins() {
        reads++
        return [
          {
            ...original,
            id: `origin-${i}`,
            skillId: `project/item-${i}`,
            path: localPath(`/workspace/.skills/item-${i}`),
          },
        ]
      },
    }))
    const select = skillagerNativeSelector(
      { ...report, lineages },
      syncContext,
      syncLibrary.id,
    )
    expect(reads).toBe(5000)
    for (let i = 0; i < 5000; i++) {
      const row = {
        ...native,
        id: `project/item-${i}`,
        projectSkill: {
          ...native.projectSkill!,
          path: localPath(`/workspace/.skills/item-${i}`),
        },
      }
      expect(select(row)?.originId).toBe(`origin-${i}`)
    }
    expect(reads).toBe(5000)
  })
})

it.each(['codex', 'claude'] as const)(
  'keeps %s remote Stub Remove unavailable using the actual copy host, while Full Remove remains target-owned',
  (agent) => {
    const target = hostPath(asHostId('ssh:fixture'), '/workspace/skill')
    for (const local of [true, false]) {
      for (const mode of ['native', 'stub']) {
        const row = {
          ...member,
          routerMembership: undefined,
          workspace: { id: 'skill', agent, target, mode, status: 'current' },
        }
        expect(
          exposureActions(row, local, syncLibrary.id).find(
            (action) => action.action === 'remove',
          )?.disabled,
        ).toBe(mode === 'stub')
      }
    }
  },
)
it('uses one unmanaged-native predicate and never associates foreign library or managed rows as native originals', () => {
  const foreign: SkillagerMetadata = {
    ...native,
    source: { type: 'collection', ownership: 'library', libraryId: 'foreign' },
  }
  const managed: SkillagerMetadata = {
    ...native,
    projectSkill: { ...native.projectSkill!, managed: true },
  }
  for (const row of [foreign, managed]) {
    expect(isNativeProjectSkill(row)).toBe(false)
    expect(
      exposureActions(row, true, syncLibrary.id).filter((action) => !action.disabled),
    ).toEqual([])
    expect(
      skillagerNativeSelector(syncStatus(), syncContext, syncLibrary.id)(row),
    ).toBeUndefined()
  }
  expect(isNativeProjectSkill(native)).toBe(true)
})
