import { localPath } from '../../src/shared/host-path'
import type { SkillagerLifecycleRequest } from '../../src/shared/skillager-exposure-plan'
import { planCommand } from '../../src/main/skillager/skillager-exposure-plan-contract'
import {
  syncContext,
  syncLibrary,
  syncSelection,
  syncHash,
} from './skillager-sync-fixture'

export { syncSelection as planSelection }
export const planToken = 'b'.repeat(64)
export const planRequest: SkillagerLifecycleRequest = {
  connectionId: 'connection',
  requestId: 1,
  workspaceRoot: syncContext,
  agent: 'codex',
  destination: { projectId: 'project', workspaceId: 'workspace', root: syncContext },
  action: 'plan',
  plan: {
    schema: 'skillager.exposure-request.v1',
    action: 'group',
    name: 'Guidance',
    library_id: syncLibrary.id,
    members: ['lib/example'],
    replace: [],
  },
  origins: [],
  exposures: [],
}
export const planFile = { type: 'file', mode: 0o644, size: 48, sha256: syncHash }
export function planResponse() {
  const target = localPath('/workspace/.agents/skills/router-guidance')
  return {
    schema: 'skillager.exposure-plan.v1',
    status: 'would_apply',
    request: planRequest.plan,
    project: syncContext.path,
    agent: 'codex',
    scope: 'project',
    library_id: syncLibrary.id,
    sources: [
      {
        id: 'lib/example',
        root: '/library/skills/example',
        entrypoint: '/library/skills/example/SKILL.md',
        content_hash: syncHash,
        trust: 'reviewed',
        source: {
          ownership: 'library',
          library_id: syncLibrary.id,
          library_root: '/library',
          collection: 'lib',
          type: 'collection',
        },
        compatibility: null,
        approval: {
          evidence_id: syncHash,
          decision_skill_id: 'lib/example',
          scope: 'global',
          state: 'reviewed',
          content_hash: syncHash,
          lint_override: false,
          risk_override: false,
        },
        target_state: { tree: syncHash, mode: 0o755 },
        lineages: [],
      },
    ],
    group: {
      tag: 'guidance',
      before_members: [],
      after_members: ['lib/example'],
      tag_policy: 'create',
      before_tag_members: [],
      after_tag_members: ['lib/example'],
    },
    staging: {
      candidate_bytes: 64,
      retained_original_bytes: 0,
      transfer_reserve_bytes: 64,
      peak_bytes: 128,
      limit_bytes: 128 * 1024 * 1024,
    },
    targets: [
      {
        target_id: 'c'.repeat(64),
        kind: 'tags',
        path: '/workspace/.skillager/tags.json',
        tag: 'guidance',
        action: 'create',
        before: null,
        after: { state_hash: syncHash, mode: 0o644 },
        file_effects: [
          {
            path: '.',
            action: 'create',
            before: null,
            after: {
              type: 'file',
              mode: 0o644,
              metadata: { tags: { guidance: { skill_ids: ['lib/example'] } } },
              generated_fields: {
                'tags.guidance.updated_at': 'UTC membership change time',
              },
            },
          },
        ],
      },
      {
        target_id: 'd'.repeat(64),
        kind: 'router',
        path: target.path,
        exposure_id: 'router-guidance',
        mode: 'router',
        tag: 'guidance',
        skill_ids: ['lib/example'],
        action: 'create',
        before: null,
        after: { state_hash: syncHash, mode: 0o755 },
        file_effects: [
          { path: 'SKILL.md', action: 'create', before: null, after: planFile },
          {
            path: 'skillager.materialized.yaml',
            action: 'create',
            before: null,
            after: {
              type: 'file',
              mode: 0o644,
              metadata: {
                schema: 'skillager.router.v1',
                projection_kind: 'router-tag',
                projection_identity: 'router-tag:guidance',
                id: 'router/guidance',
                source_id: 'router/guidance',
                source_type: 'skillager-router',
                router_kind: 'tag',
                selection_kind: 'tag',
                router_slug: 'router-guidance',
                tag: 'guidance',
                skill_ids: ['lib/example'],
                member_sources: [
                  { skill_id: 'lib/example', source_library_id: syncLibrary.id },
                ],
                source_hash: syncHash,
                agent: 'codex',
                scope: 'project',
              },
              generated_fields: {
                materialized_at: 'UTC installation time',
                materialized_fingerprint:
                  'advisory fingerprint of installed file metadata',
                materialized_sidecar_hash:
                  'integrity hash of the complete generated sidecar',
              },
            },
          },
        ],
      },
    ],
    confirmation_token: planToken,
    next_command_argv: [
      'skillager',
      ...planCommand(planRequest),
      '--yes',
      '--confirmation-token',
      planToken,
    ],
  }
}
export function planApplied() {
  const response = planResponse()
  return {
    ...response,
    status: 'applied',
    plan_hash: planToken,
    reason_code: null,
    results: response.targets.map((target) => ({
      target_id: target.target_id,
      kind: target.kind,
      path: target.path,
      action: target.action,
      status: 'applied',
      observed_state_hash: syncHash,
      reason_code: null,
      recovery_path: null,
    })),
  }
}
