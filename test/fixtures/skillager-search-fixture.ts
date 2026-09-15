import type {
  SkillagerMetadata,
  SkillagerSearchRequest,
  SkillagerSearchRows,
} from '../../src/shared/skillager'
import { localPath } from '../../src/shared/host-path'

export const searchLibrary = {
  id: '4f0467b4-bf3e-4c85-a11e-aac0f6071398',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
export const searchRequest: SkillagerSearchRequest = {
  connectionId: 'connection',
  requestId: 1,
  workspaceRoot: localPath('/project'),
  agent: 'codex',
  browseAgent: 'all',
  query: 'merge',
  scope: 'workspace',
  view: 'skills',
  includeInstalled: true,
}
export function searchEnvelope() {
  const occurrence = {
    id: 'a'.repeat(64),
    kind: 'library',
    path: '/library/skills/merge',
    entrypoint: '/library/skills/merge/SKILL.md',
    agent: null as string | null,
    source_identity: null as string | null,
    exposure: undefined as Record<string, unknown> | undefined,
  }
  return {
    schema: 'skillager.search.v1',
    status: 'completed',
    reason_code: null as string | null,
    policy: {
      view: 'skills',
      include_installed: true,
      scope: 'workspace',
      preferred_agent: null as string | null,
      compatible_only: false,
    },
    context: {
      project_root: '/project' as string | null,
      installed_observation: 'observed',
    },
    limit: 50,
    results: [
      {
        id: 'lib/merge',
        name: 'Merge',
        summary: 'Metadata',
        trust: 'reviewed',
        root: occurrence.path,
        entrypoint: occurrence.entrypoint,
        content_hash: 'b'.repeat(64),
        source: {
          type: 'collection',
          ownership: 'library',
          library_id: searchLibrary.id,
          collection: 'lib',
        },
        tags: [],
        reasons: [],
        exposure: 'unknown',
        scan: { findings: [{ excerpt: 'PRIVATE BODY' }], risk: 'low' },
        search: {
          group_id: 'c'.repeat(64),
          canonical: { library_id: searchLibrary.id, skill_id: 'lib/merge' },
          occurrence,
          group_occurrences: 2,
          installed: true as boolean | null,
          match: {
            occurrence_id: occurrence.id,
            skill_id: 'lib/merge',
            content_hash: 'b'.repeat(64),
            score: 2,
            reasons: ['name:merge'],
            occurrence: { ...occurrence },
          },
        },
      },
    ],
  }
}

/** Metadata-port fixture; public CLI schema validation has its own adapter evidence. */
export function skillagerSearchResult(
  request: Pick<
    SkillagerSearchRequest,
    'scope' | 'agent' | 'browseAgent' | 'view' | 'includeInstalled'
  >,
  rows: readonly SkillagerMetadata[] = [],
): SkillagerSearchRows {
  return {
    rows,
    search: {
      scope: request.scope,
      browseAgent: request.browseAgent ?? request.agent,
      view: request.view ?? 'skills',
      includeInstalled: request.includeInstalled ?? false,
      installedObservation: 'observed',
      coverage: 'local-project',
    },
  }
}
