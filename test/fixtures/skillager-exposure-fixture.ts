import { localPath } from '../../src/shared/host-path'
import type { SkillagerExposureRequest } from '../../src/shared/skillager-exposure'
import type { ProjectState } from '../../src/shared/workspace-types'
import { exposureCommand } from '../../src/main/skillager/skillager-exposure-contract'

export const hash = 'a'.repeat(64),
  token = 'b'.repeat(64)
export const selection = {
  executable: localPath('/skillager'),
  catalog: localPath('/catalog'),
  version: 'skillager 0.9.0',
  environment: {},
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}
export const request: SkillagerExposureRequest = {
  connectionId: 'connection',
  requestId: 1,
  workspaceRoot: localPath('/origin'),
  destination: { projectId: 'project', workspaceId: 'other', root: localPath('/other') },
  agent: 'codex',
  skillId: 'lib/demo',
  mode: 'native',
  action: 'add',
}
export const file = { type: 'file', mode: 0o644, size: 20, sha256: hash }
export function exposureResponse(at: SkillagerExposureRequest = request) {
  const target = `${at.destination.root.path}/.agents/skills/lib-demo`,
    remove = at.action === 'remove'
  const metadata = {
    schema: 'skillager.materialized.v1',
    projection_kind: 'direct',
    projection_identity: 'direct:lib/demo',
    id: at.skillId,
    source_id: at.skillId,
    source_type: at.mode === 'stub' ? 'skillager-stub' : 'collection',
    source_entrypoint: '/library/skills/demo/SKILL.md',
    source_hash: hash,
    source_library_id: 'library',
    agent: at.agent,
    scope: 'project',
  }
  const effects = ['SKILL.md', 'support.md', 'skillager.materialized.yaml'].map(
    (path) => ({
      path,
      action: remove ? 'remove' : at.action === 'change' ? 'replace' : 'create',
      before: remove || at.action === 'change' ? file : null,
      after: remove
        ? null
        : path === 'skillager.materialized.yaml'
          ? {
              type: 'file',
              mode: 0o644,
              metadata,
              generated_fields: {
                materialized_at: 'UTC installation time',
                materialized_fingerprint:
                  'advisory fingerprint of installed file metadata',
                materialized_sidecar_hash:
                  'integrity hash of the complete generated sidecar',
              },
            }
          : file,
    }),
  )
  const preview = {
    schema: remove
      ? 'skillager.exposure-remove-preview.v1'
      : 'skillager.exposure-preview.v1',
    target_state_hash: remove || at.action === 'change' ? hash : null,
    target_directory: {
      before_mode: remove || at.action === 'change' ? 0o755 : null,
      after_mode: remove ? null : 0o755,
    },
    file_effects: effects,
    source: {
      id: at.skillId,
      root: '/library/skills/demo',
      entrypoint: '/library/skills/demo/SKILL.md',
      content_hash: hash,
      trust: 'reviewed',
      source: {
        type: 'collection',
        ownership: 'library',
        library_id: 'library',
        library_root: '/library',
        collection: 'lib',
      },
    },
    project: at.destination.root.path,
    agent: at.agent,
    mode: at.mode,
    scope: 'project',
    target,
    confirmation_token: token,
  }
  const row = {
    schema: remove ? 'skillager.exposure.v1' : 'skillager.exposure-result.v1',
    skill_id: at.skillId,
    exposure_id: 'lib-demo',
    agent: at.agent,
    mode: at.mode,
    scope: 'project',
    target,
    status: remove ? 'would_remove' : 'would_expose',
    current_status: 'current',
    local_changes: false,
    requires_force: false,
    preview,
    next_command_argv: [
      'skillager',
      ...exposureCommand(at),
      '--yes',
      '--confirmation-token',
      token,
    ],
  }
  return {
    row,
    value: remove ? { schema: 'skillager.exposure-remove.v1', results: [row] } : [row],
  }
}
export function projectState(root = localPath('/origin')): ProjectState {
  const workspaces = [root, localPath('/other')].map((root, index) => ({
    id: index ? 'other' : 'origin',
    root,
    name: index ? 'Other worktree' : 'Origin',
    main: index === 0,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }))
  return {
    revision: 1,
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project',
    activeWorkspaceId: 'origin',
    projects: [
      {
        id: 'project',
        registeredRoot: root,
        displayName: 'Project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: 'origin',
        workspaces,
      },
    ],
  }
}
