import { SKILLAGER_AGENTS } from '../../shared/skillager'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { SkillagerWorkspaceExposure } from '../../shared/skillager'
import type { SkillagerExposureCliPort } from '../skillager/skillager-exposure-port'

/** Fake only the CLI boundary; Electron exercises production IPC and one-use ownership. */
export function skillagerExposureFixture(root: HostPath) {
  const copies = new Map<string, SkillagerWorkspaceExposure>([
    [
      'lib-skill-1',
      {
        id: 'lib-skill-1',
        skillId: 'lib/skill-1',
        target: joinHostPath(root, '.agents/skills/lib-skill-1'),
        mode: 'native',
        status: 'current',
      },
    ],
  ])
  const file = { type: 'file' as const, mode: 0o644, size: 24, sha256: 'a'.repeat(64) }
  const cli: SkillagerExposureCliPort = {
    previewExposure(_selection, request) {
      const id = request.skillId.replace('/', '-'),
        existing = copies.get(id),
        removing = request.action === 'remove'
      const target =
        existing?.target ??
        joinHostPath(
          request.destination.root,
          SKILLAGER_AGENTS.find((agent) => agent.id === request.agent)!
            .projectSkillRoots[0],
          id,
        )
      return Promise.resolve({
        confirmationToken: 'fixture-private-exposure-token',
        detail: {
          request,
          target,
          sourceHash: removing ? undefined : 'b'.repeat(64),
          targetHash: existing ? 'a'.repeat(64) : null,
          beforeMode: existing ? 0o755 : null,
          afterMode: removing ? null : 0o755,
          effects: ['SKILL.md', 'support.md', 'skillager.materialized.yaml'].map(
            (path) => {
              const before = existing ? file : null,
                after =
                  removing || (path === 'support.md' && request.mode === 'stub')
                    ? null
                    : file
              return {
                path,
                action:
                  after === null ? 'remove' : before === null ? 'create' : 'replace',
                before,
                after,
              }
            },
          ),
        },
      })
    },
    applyExposure(_selection, snapshot) {
      const { request, target } = snapshot.detail,
        id = request.skillId.replace('/', '-')
      if (request.action === 'remove') copies.delete(id)
      else
        copies.set(id, {
          id,
          skillId: request.skillId,
          target,
          mode: request.mode,
          status: 'current',
        })
      return Promise.resolve({
        status: request.action === 'remove' ? 'removed' : 'exposed',
        skillId: request.skillId,
        target,
        mode: request.mode,
      })
    },
  }
  return { cli, exposures: () => Promise.resolve([...copies.values()]) }
}
