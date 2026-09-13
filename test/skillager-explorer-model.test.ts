import { expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type {
  SkillagerMetadata,
  SkillagerMetadataResult,
  SkillagerWorkspaceExposure,
} from '../src/shared/skillager'
import { skillagerExplorerRows } from '../src/renderer/src/skillager/skillager-explorer-model'
import {
  skillagerMetadataKey,
  skillagerProjectRows,
  skillagerTabs,
  skillagerWorkspaceMetadata,
} from '../src/renderer/src/skillager/skillager-model'

const source: SkillagerMetadata = {
  id: 'lib/guide',
  name: 'Guide',
  description: 'Source',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: 'library-a' },
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const copy: SkillagerWorkspaceExposure = {
  id: 'lib-guide',
  agent: 'codex',
  skillId: source.id,
  sourceLibraryId: 'library-a',
  target: localPath('/project/.agents/skills/lib-guide'),
  mode: 'native',
  status: 'current',
}
const router: SkillagerWorkspaceExposure = {
  id: 'router-guide',
  agent: 'claude',
  target: localPath('/project/.claude/skills/router-guide'),
  mode: 'router',
  status: 'current',
  router: {
    slug: 'router-guide',
    kind: 'tag',
    tag: 'Guides',
    skillIds: [source.id],
    memberSources: [{ skillId: source.id, sourceLibraryId: source.source.libraryId }],
  },
}
const result: SkillagerMetadataResult = {
  rows: [source],
  exposures: [
    copy,
    {
      ...copy,
      agent: 'claude',
      mode: 'stub',
      target: localPath('/project/.claude/skills/lib-guide'),
    },
    router,
  ],
  checkedAt: 100,
  durationMs: 1,
}

it('keeps exact copies separate from their source and opens stable source/copy/member tabs', () => {
  const library = skillagerWorkspaceMetadata(result)
  expect(library[0]!.workspaceCopies).toHaveLength(2)
  expect(library[0]!.workspace).toBeUndefined()
  const projected = skillagerExplorerRows(
    library,
    library,
    new Set([skillagerMetadataKey(library[0]!)]),
  )
  expect(projected.length).toBe(3)
  expect(projected.slice(0, 3).map((row) => row.metadata.workspace?.agent)).toEqual([
    undefined,
    'codex',
    'claude',
  ])
  const project = skillagerProjectRows(result)
  const expanded = skillagerExplorerRows(
    project,
    library,
    new Set(project.map(skillagerMetadataKey)),
  )
  const selections = [...projected.slice(0, 3), expanded.at(3)!]
  let state = { tabs: [] } as ReturnType<typeof skillagerTabs>
  for (const row of selections)
    state = skillagerTabs(state, { type: 'select', metadata: row.metadata })
  expect(new Set(state.tabs.map((tab) => tab.id)).size).toBe(4)
  const refreshed = skillagerTabs(state, {
    type: 'observe',
    result: { ...result, rows: [{ ...source, description: 'Refreshed' }] },
  })
  expect(refreshed.tabs.map((tab) => tab.id)).toEqual(state.tabs.map((tab) => tab.id))
  expect(
    refreshed.tabs.slice(0, 3).every((tab) => tab.metadata.description === 'Refreshed'),
  ).toBe(true)
  expect(refreshed.tabs[3]!.metadata.workspaceFreshness).toBe('fresh')
  expect(refreshed.tabs[3]!.metadata.source.ownership).toBe('library')
  expect(refreshed.tabs[3]!.metadata.description).toBe('Refreshed')
  expect(
    skillagerTabs(refreshed, {
      type: 'observe-project',
      result: { ...result, exposures: [copy] },
    }).tabs[3]!.metadata,
  ).toMatchObject({ workspaceFreshness: 'unavailable', trust: 'reviewed' })
})

it('never joins foreign or unproven same-ID copies/members to the currently registered library', () => {
  const foreign = { ...source, source: { ...source.source, libraryId: 'library-b' } }
  const data = { ...result, rows: [foreign] }
  expect(skillagerWorkspaceMetadata(data)[0]!.workspaceCopies).toEqual([])
  const project = skillagerProjectRows(data)
  expect(project.every((row) => row.source.ownership === 'unknown')).toBe(true)
  const members = skillagerExplorerRows(
    project,
    [foreign],
    new Set(project.map(skillagerMetadataKey)),
  )
  expect(members.at(3)!.metadata.source.ownership).toBe('unknown')
  expect(
    skillagerProjectRows({
      ...result,
      exposures: [{ ...copy, sourceLibraryId: undefined }],
    })[0]!.source.ownership,
  ).toBe('unknown')
})

it('keeps every reported agent copy visible so counts and disclosure describe the same entries', () => {
  const library = skillagerWorkspaceMetadata(result)
  const projection = skillagerExplorerRows(
    library,
    library,
    new Set([skillagerMetadataKey(library[0]!)]),
  )
  expect(projection.sourceCount).toBe(library.length)
  expect(projection.at(0)!.expandable).toBe(true)
  expect(projection.at(0)!.metadata.workspaceCopies).toHaveLength(2)
  expect(
    projection.slice(1, projection.length).map((row) => row.metadata.workspace?.agent),
  ).toEqual(['codex', 'claude'])
  const project = skillagerProjectRows(result)
  expect(skillagerExplorerRows(project, library, new Set()).length).toBe(project.length)
})

it('projects only the requested range with millions of repeated public member references', () => {
  const ids = Array.from({ length: 5000 }, (_, n) => `lib/member-${n}`)
  let memberReads = 0
  const members = new Proxy(ids, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) memberReads++
      return Reflect.get(target, key, receiver) as unknown
    },
  })
  const sources = Array.from({ length: 5000 }, (_, n) => ({
    ...source,
    id: `router-${n}`,
    workspace: {
      ...router,
      id: `router-${n}`,
      target: localPath(`/project/routers/${n}`),
      router: { ...router.router!, skillIds: members },
    },
  }))
  const projection = skillagerExplorerRows(
    sources,
    [],
    new Set(sources.map(skillagerMetadataKey)),
  )
  expect(projection.length).toBe(40_000)
  expect(projection.refused).toHaveLength(4993)
  expect(memberReads).toBe(0)
  const window = projection.slice(1, 21)
  expect(window).toHaveLength(20)
  expect(memberReads).toBe(20)
  expect(window.at(-1)!.metadata.id).toBe('lib/member-19')
  expect(projection.indexOf(window[0]!.key, window[0])).toBe(1)
  const last = skillagerExplorerRows(
    sources,
    [],
    new Set([skillagerMetadataKey(sources.at(-1)!)]),
  )
  expect(last.length).toBe(10_000)
  expect(last.at(last.length - 1)!.metadata.id).toBe('lib/member-4999')
  const collapsed = skillagerExplorerRows(sources, [], new Set())
  expect(collapsed.length).toBe(5000)
  expect(collapsed.indexOf(window[0]!.key, window[0])).toBe(-1)
  expect(collapsed.indexOf(window[0]!.parent!)).toBe(0)
})

it.each(['observe', 'observe-project'] as const)(
  '%s distinguishes unavailable copy/member observation from proven disappearance',
  (type) => {
    const canonical = { ...source, contentHash: 'a'.repeat(64) }
    const copyMetadata = skillagerProjectRows({ ...result, rows: [canonical] })[0]!
    const memberMetadata = { ...canonical, routerMembership: router }
    const original = {
      tabs: [copyMetadata, memberMetadata].map((metadata) => ({
        id: skillagerMetadataKey(metadata),
        metadata,
      })),
    }
    const freshSource = {
      ...canonical,
      description: 'Still in the library',
      contentHash: 'b'.repeat(64),
    }
    const unavailable = skillagerTabs(original, {
      type,
      result: { ...result, rows: [freshSource], exposures: undefined },
    })
    expect(unavailable.tabs.map((tab) => tab.id)).toEqual(
      original.tabs.map((tab) => tab.id),
    )
    for (const tab of unavailable.tabs)
      expect(tab.metadata).toMatchObject({
        trust: 'reviewed',
        contentHash: freshSource.contentHash,
        description: freshSource.description,
        workspaceFreshness: 'unavailable',
      })
    const absent = skillagerTabs(unavailable, {
      type,
      result: { ...result, rows: [freshSource], exposures: [] },
    })
    expect(absent.tabs[0]!.metadata.description).toContain(
      'project copy is no longer reported',
    )
    expect(absent.tabs[1]!.metadata.description).toContain(
      'router membership is no longer reported',
    )
    expect(absent.tabs.every((tab) => tab.metadata.trust === 'reviewed')).toBe(true)
    const unavailableWithoutSource = skillagerTabs(original, {
      type,
      result: { ...result, rows: [], exposures: undefined },
    })
    expect(
      unavailableWithoutSource.tabs.every(
        (tab) => tab.metadata.contentHash === canonical.contentHash,
      ),
    ).toBe(true)
    expect(
      unavailableWithoutSource.tabs.every(
        (tab) => !tab.metadata.description.includes('no longer'),
      ),
    ).toBe(true)
  },
)

it('only reports a canonical source gone after the complete library inventory omits it', () => {
  const selected = skillagerTabs({ tabs: [] }, { type: 'select', metadata: source })
  const partial = skillagerTabs(selected, {
    type: 'observe-project',
    result: { ...result, rows: [] },
  })
  expect(partial.tabs[0]!.metadata.trust).toBe('reviewed')
  const complete = skillagerTabs(partial, {
    type: 'observe',
    result: { ...result, rows: [], exposures: [] },
  })
  expect(complete.tabs[0]!.metadata).toMatchObject({
    trust: 'unknown',
    description: 'This skill is no longer in the personal library.',
  })
})
