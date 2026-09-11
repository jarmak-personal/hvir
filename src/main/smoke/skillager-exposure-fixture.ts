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
  copies.set('lib-skill-0', {
    id: 'lib-skill-0',
    skillId: 'lib/skill-0',
    target: joinHostPath(root, '.agents/skills/lib-skill-0'),
    mode: 'native',
    status: 'source_unavailable',
  })
  const file = { type: 'file' as const, mode: 0o644, size: 24, sha256: 'a'.repeat(64) }
  const cli: SkillagerExposureCliPort = {
    updateSourceHash: () => Promise.resolve('c'.repeat(64)),
    async previewExposure(_selection, request) {
      // Delayed read-only completion exercises real IPC cancellation and late-result revocation.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const id = request.skillId.replace('/', '-'),
        existing = copies.get(id),
        removing = request.action === 'remove'
      const target =
        existing?.target ?? joinHostPath(request.destination.root, '.fixture-skills', id)
      return Promise.resolve({
        confirmationToken: 'fixture-private-exposure-token',
        detail: {
          request,
          target,
          sourceHash: removing
            ? undefined
            : request.skillId === 'lib/skill-0'
              ? 'a'.repeat(64)
              : 'b'.repeat(64),
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
  return {
    cli,
    exposures: () => Promise.resolve([...copies.values()]),
    accepted: (skillId: string) => {
      const copy = copies.get(skillId.replace('/', '-'))
      if (copy)
        copies.set(copy.id, {
          ...copy,
          status: 'source_update',
          expectedSourceHash: 'a'.repeat(64),
        })
    },
  }
}
