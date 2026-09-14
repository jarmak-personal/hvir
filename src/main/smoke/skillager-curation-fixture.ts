import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { SkillagerWorkspaceExposure } from '../../shared/skillager'
import type { SkillagerPlanTarget } from '../../shared/skillager-exposure-plan'
import type { SkillagerLocalActionPort } from '../skillager/skillager-exposure-plan-commands'
import { SkillagerError } from '../skillager/skillager-port'

/** Delayed CLI boundary for the rendered named-group/Remove journey; public CLI has separate gates. */
export function skillagerCurationFixture(
  root: HostPath,
  libraryId: string,
  copies: Map<string, SkillagerWorkspaceExposure>,
): SkillagerLocalActionPort {
  const hash = 'a'.repeat(64),
    file = { type: 'file' as const, mode: 0o644, size: 24, sha256: hash }
  return {
    async previewLocalAction(_selection, request) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (request.action === 'remove-router')
        return {
          confirmationToken: 'fixture-private-router-token',
          preview: {},
          detail: {
            kind: 'remove-router',
            request,
            target: request.exposure.target,
            beforeMode: 0o755,
            effects: ['SKILL.md', 'skillager.materialized.yaml'].map((path) => ({
              path,
              action: 'remove',
              before: file,
              after: null,
            })),
          },
        }
      if (request.plan.action !== 'group')
        throw new SkillagerError(
          'review-refused',
          'This interaction fixture supports named grouping only.',
        )
      const tag = 'smoke-guidance',
        id = 'router-smoke-guidance',
        path = joinHostPath(root, '.agents/skills', id)
      const targets: SkillagerPlanTarget[] = [
        {
          id: 'b'.repeat(64),
          path: joinHostPath(root, '.skillager/tags.json'),
          kind: 'tags',
          action: 'create',
          before: null,
          after: { hash, mode: 0o644 },
          effects: [
            {
              path: '.',
              action: 'create',
              before: null,
              after: {
                type: 'file',
                mode: 0o644,
                metadata: JSON.stringify({
                  tags: { [tag]: { skill_ids: request.plan.members } },
                }),
                generatedFields: [
                  'tags.smoke-guidance.updated_at: UTC membership change time',
                ],
              },
            },
          ],
        },
        {
          id: 'c'.repeat(64),
          path,
          kind: 'router',
          action: 'create',
          exposureId: id,
          before: null,
          after: { hash, mode: 0o755 },
          effects: [
            { path: 'SKILL.md', action: 'create', before: null, after: file },
            {
              path: 'skillager.materialized.yaml',
              action: 'create',
              before: null,
              after: {
                type: 'file',
                mode: 0o644,
                metadata: JSON.stringify({
                  schema: 'skillager.router.v1',
                  tag,
                  skill_ids: request.plan.members,
                  member_sources: request.plan.members.map((skill_id) => ({
                    skill_id,
                    source_library_id: libraryId,
                  })),
                }),
                generatedFields: [
                  'materialized_at: UTC installation time',
                  'materialized_fingerprint: advisory installed metadata fingerprint',
                  'materialized_sidecar_hash: complete generated sidecar integrity',
                ],
              },
            },
          ],
        },
      ]
      return {
        confirmationToken: 'fixture-private-curation-token',
        payload: {},
        detail: {
          kind: 'plan',
          request,
          targets,
          sources: request.plan.members.map((id) =>
            JSON.stringify({
              id,
              content_hash: hash,
              trust: 'reviewed',
              approval: { evidence_id: hash },
            }),
          ),
          group: JSON.stringify({
            tag,
            before_members: [],
            after_members: request.plan.members,
            tag_policy: 'create',
            before_tag_members: [],
            after_tag_members: request.plan.members,
          }),
          staging: JSON.stringify({
            candidate_bytes: 128,
            retained_original_bytes: 0,
            transfer_reserve_bytes: 128,
            peak_bytes: 256,
            limit_bytes: 134217728,
          }),
        },
      }
    },
    async applyLocalAction(_selection, snapshot, _signal, submitted) {
      submitted()
      if (snapshot.detail.kind === 'remove-router') {
        copies.delete(snapshot.detail.request.exposure.id)
        return Promise.resolve({
          kind: 'remove-router',
          status: 'removed',
          target: snapshot.detail.target,
        })
      }
      const { request } = snapshot.detail
      if (request.plan.action !== 'group')
        throw new SkillagerError(
          'review-refused',
          'Unsupported interaction fixture action.',
        )
      const target = snapshot.detail.targets.find((target) => target.kind === 'router')!
      copies.set(target.exposureId!, {
        id: target.exposureId!,
        agent: request.agent,
        target: target.path,
        mode: 'router',
        status: 'current',
        router: {
          kind: 'tag',
          slug: target.exposureId!,
          tag: 'smoke-guidance',
          skillIds: request.plan.members,
          memberSources: request.plan.members.map((skillId) => ({
            skillId,
            sourceLibraryId: libraryId,
          })),
        },
      })
      return Promise.resolve({
        kind: 'plan',
        status: 'applied',
        targets: snapshot.detail.targets.map((target) => ({
          id: target.id,
          path: target.path,
          status: 'applied',
          observedHash: hash,
        })),
      })
    },
  }
}
