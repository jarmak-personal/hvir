import { localPath } from '../../src/shared/host-path'
import {
  parseSkillagerSyncStatus,
  parseSkillagerSyncCompletion,
} from '../../src/main/skillager/skillager-library-sync-contract'
export const syncLibrary = {
  id: '45c79d81-a615-4123-b35e-fae2d7362442',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
export const syncContext = localPath('/workspace')
export const syncSelection = {
  executable: localPath('/tools/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.1',
  environment: { HOME: '/fixture/home' },
  library: syncLibrary,
}
export const syncHash = 'a'.repeat(64)
export function syncLineage() {
  return {
    schema: 'skillager.library-lineage.v1',
    lineage_id: 'lineage',
    source_identity: 'source',
    source_approval: {
      evidence_id: 'evidence',
      decision_skill_id: 'project/example',
      scope: 'project',
      state: 'reviewed',
      content_hash: syncHash,
      lint_override: false,
      risk_override: false,
    },
    canonical: {
      library_id: syncLibrary.id,
      skill_id: 'lib/example',
      path: '/library/skills/example',
      accepted_hash: syncHash,
      working_hash: syncHash,
      acceptance: 'accepted',
      trust: 'reviewed',
      reuse: 'all-projects',
      git_commit: null,
    },
    origins: [
      {
        origin_id: 'origin',
        skill_id: 'project/example',
        source_type: 'project',
        path: '/workspace/.skills/example',
        entrypoint: '/workspace/.skills/example/SKILL.md',
        native: { agent: 'codex', scope: 'project', project_root: '/workspace' },
        provenance: {},
        observation: {
          status: 'current',
          content_hash: syncHash,
          trust: 'reviewed',
          approval_evidence_id: 'evidence',
        },
      },
    ],
    preservation: 'verified',
    reason_code: null,
  }
}
export function syncStatusRaw() {
  return {
    schema: 'skillager.library-sync-status.v1',
    library: {
      library_id: syncLibrary.id,
      root: syncLibrary.root.path,
      git_mode: 'disabled',
    },
    context: { project_root: syncContext.path, discovery: 'effective-local' },
    coverage: {
      discovered_origins: 1,
      approved_origins: 1,
      selected_sources: 1,
      processed_sources: 1,
      complete: true,
      discovery_error_count: 0,
    },
    lineages: [syncLineage()],
    candidates: [
      {
        source_identity: 'source',
        canonical_skill_id: 'lib/example',
        state: 'current',
        reason_code: null,
      },
    ],
  }
}
export function syncCompletionRaw() {
  const status = syncStatusRaw()
  return {
    schema: 'skillager.library-sync.v1',
    status: 'completed',
    library: status.library,
    context: status.context,
    coverage: status.coverage,
    counts: {
      created: 1,
      updated: 0,
      unchanged: 0,
      conflict: 0,
      skipped: 0,
      failed: 0,
      uncertain: 0,
    },
    items: [
      {
        source_identity: 'source',
        origin_ids: ['origin'],
        lineage_id: 'lineage',
        canonical_skill_id: 'lib/example',
        outcome: 'created',
        phase: 'accepted',
        accepted_hash: syncHash,
        repair: 'none',
        reason_code: null,
      },
    ],
  }
}
export const syncStatus = () =>
  parseSkillagerSyncStatus(syncStatusRaw(), 0, syncLibrary, syncContext)
export const syncCompletion = () =>
  parseSkillagerSyncCompletion(syncCompletionRaw(), 0, syncLibrary, syncContext)
