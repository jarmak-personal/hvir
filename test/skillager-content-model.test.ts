import { expect, it } from 'vitest'
import { asHostId, hostPath, joinHostPath, localPath } from '../src/shared/host-path'
import type { SkillagerMetadata } from '../src/shared/skillager'
import {
  skillagerCanonicalContent,
  skillagerContentSelection,
} from '../src/renderer/src/skillager/skillager-content-model'
import {
  syncLibrary as library,
  syncContext as workspace,
  syncStatus,
} from './fixtures/skillager-sync-fixture'
const row: SkillagerMetadata = {
  id: 'lib/example',
  name: 'Example',
  description: '',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: library.id },
  contentHash: 'a'.repeat(64),
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const occurrence = {
  id: 'selected',
  kind: 'library' as const,
  path: joinHostPath(library.skillsRoot, 'example'),
  entrypoint: joinHostPath(library.skillsRoot, 'example/SKILL.md'),
}
const search = {
  groupId: 'group',
  occurrence,
  groupOccurrences: 2,
  installed: true,
  canonical: { libraryId: library.id, skillId: row.id },
  match: {
    occurrence,
    skillId: 'other/source',
    contentHash: 'b'.repeat(64),
    score: 1,
    reasons: ['body'],
  },
}
it('selects the accepted source hash and never the distinct match hash; explicit current reading drops only the expected version', () => {
  const selected = { ...row, search }
  expect(skillagerContentSelection(selected, library, workspace)?.expectedHash).toBe(
    row.contentHash,
  )
  expect(
    skillagerContentSelection(selected, library, workspace, true)?.expectedHash,
  ).toBeUndefined()
  expect(
    skillagerContentSelection({ ...row, trust: 'discovered' }, library, workspace)
      ?.expectedHash,
  ).toBeUndefined()
})
it.each(['full', 'stub', 'router-member'] as const)(
  'reads actual %s bytes regardless of accepted original metadata or pending canonical bytes',
  (kind) => {
    const path = localPath(`/workspace/.claude/skills/${kind}`)
    const selected = {
      ...row,
      id: 'project/original',
      source: { type: 'project', ownership: 'external' as const },
      search: {
        ...search,
        occurrence: {
          ...occurrence,
          kind,
          path,
          entrypoint: joinHostPath(path, 'SKILL.md'),
          agent: 'claude' as const,
        },
      },
    }
    expect(skillagerContentSelection(selected, library, workspace)).toMatchObject({
      kind: kind === 'router-member' ? 'router' : kind,
      root: path,
      path: joinHostPath(path, 'SKILL.md'),
      agent: 'claude',
    })
    expect(
      skillagerContentSelection(selected, library, workspace)?.expectedHash,
    ).toBeUndefined()
    const canonical = skillagerCanonicalContent(
      selected,
      library,
      new Map(),
      [],
      workspace,
    )!
    expect(canonical).toMatchObject({
      id: row.id,
      trust: 'unknown',
      source: { ownership: 'library', libraryId: library.id },
    })
    expect(canonical).not.toHaveProperty('contentHash')
    expect(canonical).not.toHaveProperty('search')
  },
)
it('keeps local library and actual SSH occurrence grants distinct and excludes arbitrary external roots', () => {
  const ssh = hostPath(asHostId('remote'), '/work')
  expect(skillagerContentSelection(row, library, ssh)?.path.hostId).toBe('local')
  const selected = {
    ...row,
    workspace: {
      id: 'copy',
      target: joinHostPath(ssh, '.agents/skills/example'),
      agent: 'codex' as const,
      mode: 'stub',
      status: 'modified',
    },
  }
  expect(skillagerContentSelection(selected, library, ssh)?.path.hostId).toBe(ssh.hostId)
  expect(skillagerContentSelection(selected, library, workspace)).toBeUndefined()
  expect(
    skillagerContentSelection(
      {
        ...row,
        search: {
          ...search,
          occurrence: {
            ...occurrence,
            kind: 'source',
            path: localPath('/external'),
            entrypoint: localPath('/external/SKILL.md'),
          },
        },
      },
      library,
      workspace,
    ),
  ).toBeUndefined()
})
it('requires a unique exact project-scoped lineage for canonical navigation and withholds ambiguous or wrong-project relations', () => {
  const lineages = syncStatus().lineages
  const original: SkillagerMetadata = {
    ...row,
    id: 'project/example',
    source: { type: 'project', ownership: 'external' },
    projectSkill: {
      path: localPath('/workspace/.skills/example'),
      agent: 'codex',
      managed: false,
    },
  }
  expect(
    skillagerCanonicalContent(original, library, new Map(), lineages, workspace)?.id,
  ).toBe('lib/example')
  expect(
    skillagerCanonicalContent(
      original,
      library,
      new Map(),
      [...lineages, ...lineages],
      workspace,
    ),
  ).toBeUndefined()
  expect(
    skillagerCanonicalContent(
      original,
      library,
      new Map(),
      lineages,
      localPath('/different'),
    ),
  ).toBeUndefined()
  const foreign = {
    ...original,
    search: {
      ...search,
      canonical: { libraryId: 'other', skillId: row.id },
      occurrence: {
        ...occurrence,
        kind: 'project-original' as const,
        path: original.projectSkill!.path,
        entrypoint: joinHostPath(original.projectSkill!.path, 'SKILL.md'),
      },
    },
  }
  expect(
    skillagerCanonicalContent(foreign, library, new Map(), lineages, workspace),
  ).toBeUndefined()
})
