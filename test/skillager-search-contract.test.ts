import { describe, expect, it } from 'vitest'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import { parseSkillagerSearchView } from '../src/main/skillager/skillager-search-contract'
import { parseSkillagerSearch } from '../src/main/skillager/skillager-cli-metadata'
import {
  skillagerMetadataKey,
  skillagerTabs,
  skillagerWorkspaceMetadata,
} from '../src/renderer/src/skillager/skillager-model'
import { exposureActions } from '../src/renderer/src/skillager/skillager-exposure-model'
import {
  searchEnvelope,
  searchLibrary,
  searchRequest,
} from './fixtures/skillager-search-fixture'

describe('versioned Skillager search metadata', () => {
  it('does not refresh selected search bytes or freshness from an unrelated inventory observation', () => {
    const raw = searchEnvelope()
    const row = parseSkillagerSearchView(raw, 0, searchLibrary, searchRequest, false)
      .rows[0]!
    const selected = {
      ...row,
      workspaceFreshness: 'stale' as const,
      workspaceCheckedAt: 1,
    }
    const tabs = skillagerTabs({ tabs: [] }, { type: 'select', metadata: selected })
    const next = skillagerTabs(tabs, {
      type: 'observe',
      result: {
        rows: [{ ...row, search: undefined, contentHash: 'f'.repeat(64) }],
        exposures: [],
        checkedAt: 2,
        durationMs: 1,
      },
    })
    expect(next.tabs[0]?.metadata).toBe(selected)
  })
  it('retains the actual matching original separately from the canonical representative and strips raw scanner text', () => {
    const raw = searchEnvelope(),
      selected = raw.results[0]!
    selected.search.match.occurrence = {
      ...selected.search.match.occurrence,
      id: 'd'.repeat(64),
      kind: 'project-original',
      agent: 'claude',
      path: '/project/.claude/skills/merge',
      entrypoint: '/project/.claude/skills/merge/SKILL.md',
      source_identity: 'e'.repeat(64),
    }
    selected.search.match.occurrence_id = 'd'.repeat(64)
    selected.search.match.skill_id = 'project/merge'
    selected.search.match.content_hash = 'f'.repeat(64)
    const value = parseSkillagerSearchView(raw, 0, searchLibrary, searchRequest, false)
    expect(value.rows[0]).toMatchObject({
      id: 'lib/merge',
      contentHash: 'b'.repeat(64),
      matchReasons: [],
      search: {
        occurrence: { kind: 'library' },
        match: {
          skillId: 'project/merge',
          contentHash: 'f'.repeat(64),
          occurrence: { agent: 'claude' },
        },
      },
    })
    expect(JSON.stringify(value)).not.toContain('PRIVATE')
    expect(value.rows[0]?.projectSkill).toBeUndefined()
  })
  it('keeps native project path and concrete agent in new and legacy search', () => {
    const raw = searchEnvelope(),
      selected = raw.results[0]!
    Object.assign(selected, {
      id: 'project/merge',
      source: { type: 'project', agent: 'claude' },
      root: '/project/.claude/skills/merge',
      entrypoint: '/project/.claude/skills/merge/SKILL.md',
    })
    Object.assign(selected.search.occurrence, {
      id: 'd'.repeat(64),
      kind: 'project-original',
      path: selected.root,
      entrypoint: selected.entrypoint,
      agent: 'claude',
      source_identity: 'e'.repeat(64),
    })
    for (const rows of [
      parseSkillagerSearchView(raw, 0, searchLibrary, searchRequest, false).rows,
      parseSkillagerSearch([selected], searchLibrary, false, localPath('/project')),
    ]) {
      expect(rows[0]?.projectSkill).toEqual({
        path: localPath(selected.root),
        agent: 'claude',
        managed: false,
      })
      expect(
        exposureActions(rows[0]!).find((item) => item.action === 'files')?.disabled,
      ).toBe(false)
    }
  })
  it.each(['full', 'stub', 'router-member'])(
    'preserves %s target identity separately from source bytes and refreshes only exact target state',
    (kind) => {
      const raw = searchEnvelope(),
        selected = raw.results[0]!,
        target = localPath('/project/.claude/skills/installed')
      const mode = kind === 'full' ? 'native' : kind === 'stub' ? 'stub' : 'router'
      selected.search.occurrence = {
        ...selected.search.occurrence,
        id: 'd'.repeat(64),
        kind,
        agent: 'claude',
        path: target.path,
        entrypoint: `${target.path}/SKILL.md`,
        exposure: {
          exposure_id: 'installed',
          agent: 'claude',
          scope: 'project',
          target: target.path,
          mode,
          ...(mode === 'router'
            ? { router_slug: 'installed', router_kind: 'tag', tag: 'tools' }
            : {}),
        },
      }
      const data = {
        ...parseSkillagerSearchView(raw, 0, searchLibrary, searchRequest, false),
        checkedAt: 1,
        durationMs: 1,
        exposures: [
          {
            id: 'installed',
            agent: 'claude' as const,
            target,
            mode,
            status: 'local_edit',
            skillId: 'lib/merge',
            sourceLibraryId: searchLibrary.id,
            ...(mode === 'router'
              ? {
                  router: {
                    slug: 'installed',
                    kind: 'tag',
                    skillIds: ['lib/merge'],
                    memberSources: [
                      { skillId: 'lib/merge', sourceLibraryId: searchLibrary.id },
                    ],
                  },
                }
              : {}),
          },
        ],
      }
      const row = skillagerWorkspaceMetadata(data)[0]!
      expect(row.contentHash).toBe('b'.repeat(64))
      expect((row.workspace ?? row.routerMembership)?.target).toEqual(target)
      expect((row.workspace ?? row.routerMembership)?.currentHash).toBeUndefined()
      expect(row.workspaceFreshness).toBe('fresh')
      const tabs = skillagerTabs({ tabs: [] }, { type: 'select', metadata: row })
      const refreshed = skillagerTabs(tabs, {
        type: 'observe',
        result: {
          ...data,
          rows: [{ ...row, contentHash: 'f'.repeat(64), search: undefined }],
        },
      })
      expect(refreshed.tabs[0]?.metadata.contentHash).toBe('b'.repeat(64))
      expect(refreshed.tabs[0]?.metadata.search).toEqual(row.search)
      expect(skillagerMetadataKey(refreshed.tabs[0]!.metadata)).toBe(tabs.activeId)
      const missing = skillagerWorkspaceMetadata({ ...data, exposures: [] })[0]!
      expect(missing.workspaceFreshness).toBe('unavailable')
      expect(exposureActions(missing)).toEqual([])
    },
  )
  it.each(['policy', 'context', 'duplicate', 'pending', 'installed', 'outside'])(
    'rejects incompatible %s evidence rather than filtering a limited result',
    (change) => {
      const raw = searchEnvelope()
      if (change === 'policy') raw.policy.view = 'copies'
      if (change === 'context') raw.context.project_root = '/other'
      if (change === 'duplicate') raw.results.push(structuredClone(raw.results[0]!))
      if (change === 'pending') raw.results[0]!.trust = 'discovered'
      if (change === 'installed') raw.policy.include_installed = false
      if (change === 'outside')
        raw.results[0]!.search.occurrence.entrypoint = '/outside/SKILL.md'
      expect(() =>
        parseSkillagerSearchView(
          raw,
          0,
          searchLibrary,
          { ...searchRequest, includeInstalled: change !== 'installed' },
          false,
        ),
      ).toThrow()
    },
  )
  it('distinguishes unknown supported presence and bounded refusal from unsupported legacy CLI', () => {
    const raw = searchEnvelope()
    Object.assign(raw, {
      status: 'unavailable',
      results: [],
      reason_code: 'installed-state-unknown',
    })
    expect(() =>
      parseSkillagerSearchView(raw, 2, searchLibrary, searchRequest, false),
    ).toThrow(/Include installed/)
    raw.reason_code = 'internal-error PRIVATE'
    expect(() =>
      parseSkillagerSearchView(raw, 1, searchLibrary, searchRequest, false),
    ).toThrow('Skillager could not complete this search observation.')
  })
  it('names remote provided coverage without introducing remote paths into CLI metadata', () => {
    const raw = searchEnvelope()
    raw.policy.scope = 'library'
    raw.policy.include_installed = false
    raw.context.project_root = null
    raw.context.installed_observation = 'provided'
    raw.results[0]!.search.installed = false
    const value = parseSkillagerSearchView(
      raw,
      0,
      searchLibrary,
      {
        ...searchRequest,
        scope: 'library',
        includeInstalled: false,
        workspaceRoot: hostPath(asHostId('ssh:fixture'), '/remote'),
      },
      true,
    )
    expect(value.search).toMatchObject({
      installedObservation: 'provided',
      coverage: 'hvir-deliveries',
    })
    expect(value.rows[0]?.search?.occurrence.path.hostId).toBe('local')
  })
})
