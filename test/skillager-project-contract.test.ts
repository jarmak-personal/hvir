import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import {
  parseSkillagerProjectSkills,
  parseSkillagerProjectStatus,
} from '../src/main/skillager/skillager-cli-metadata'

const library = {
  id: '4f0467b4-bf3e-4c85-a11e-aac0f6071398',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
function row(trust = 'discovered', agent = 'codex') {
  return {
    id: `project/${agent}-${trust}`,
    name: 'Project guide',
    summary: 'Project metadata',
    root: `/workspace/.agents/skills/${agent}-${trust}`,
    trust,
    content_hash: 'a'.repeat(64),
    source: { type: 'project' },
    native: { agent, scope: 'project', managed: false, customized: false },
    body: 'PRIVATE BODY',
    approval_key: 'PRIVATE KEY',
    scan: { risk: 'low', findings: [{ message: 'PRIVATE EXCERPT' }] },
  }
}
function review(selected = [row()]) {
  return {
    selected,
    summary: { total: selected.length },
    action: {
      changed: [],
      skipped: selected
        .filter((item) => item.trust === 'lint_blocked')
        .map((item) => ({
          skill_id: item.id,
          reason: 'lint-blocked; fix source or use --override-lint --reason',
        })),
    },
  }
}
function doctor(exit = 10, working = 'missing') {
  return {
    schema: 'skillager.doctor.v1',
    project: '/workspace',
    agent: 'codex',
    exit_code: exit,
    status: exit === 0 ? 'ready' : 'review-needed',
    readiness: { can_proceed: exit === 0, artifacts_ready: true },
    state: {
      artifacts: { working_skill: { status: working } },
      review: { needed: exit === 0 ? 0 : 2 },
      lint_blocked: { count: exit === 0 ? 0 : 1 },
    },
  }
}
describe('public project metadata boundary', () => {
  it('accepts the CLI read-only lint skip shape and retains both agents/pending/blocked without private excerpts', () => {
    const rows = parseSkillagerProjectSkills(
      review([row(), row('blocked', 'claude'), row('lint_blocked', 'claude')]),
      library,
    )
    expect(rows.map((item) => item.trust)).toEqual([
      'discovered',
      'blocked',
      'lint_blocked',
    ])
    expect(rows[0]).toMatchObject({
      source: { type: 'project', ownership: 'external' },
      projectSkill: {
        path: localPath('/workspace/.agents/skills/codex-discovered'),
        agent: 'codex',
        managed: false,
      },
    })
    expect(JSON.stringify(rows)).not.toMatch(
      /PRIVATE|approval_key|findings|--override-lint/,
    )
  })
  it('does not invent completeness from an empty CLI selection', () => {
    expect(parseSkillagerProjectSkills(review([]), library)).toEqual([])
  })
  it('rejects changed actions, unrelated skipped identities, nonproject rows and malformed metadata', () => {
    const base = review()
    const payloads = [
      { ...base, action: { changed: ['approved'], skipped: [] } },
      {
        ...base,
        action: {
          changed: [],
          skipped: [
            {
              skill_id: 'elsewhere',
              reason: 'lint-blocked; fix source or use --override-lint --reason',
            },
          ],
        },
      },
      review([{ ...row(), source: { type: 'global' } }]),
      review([{ ...row(), root: 'relative' }]),
      review([{ ...row(), native: { ...row().native, agent: 'arbitrary' } }]),
    ]
    for (const payload of payloads)
      expect(() => parseSkillagerProjectSkills(payload, library)).toThrow()
  })
  it('allows the bounded 10,000-row lint inventory and rejects overflow', () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => ({
      ...row('lint_blocked'),
      id: `project/entry-${index}`,
    }))
    expect(parseSkillagerProjectSkills(review(selected), library)).toHaveLength(10_000)
    expect(() =>
      parseSkillagerProjectSkills(
        review([...selected, { ...row(), id: 'project/overflow' }]),
        library,
      ),
    ).toThrow()
  })
  it.each([0, 10, 11, 12, 13, 14])(
    'accepts public doctor diagnostic exit %i without equating artifacts_ready to Working installed',
    (exit) => {
      const result = parseSkillagerProjectStatus(
        doctor(exit),
        exit,
        localPath('/workspace'),
        'codex',
      )
      expect(result.working).toBe('missing')
      expect(result.canProceed).toBe(exit === 0)
    },
  )
  it.each(['present', 'unmanaged', 'drift', 'stale'])(
    'retains actual Working %s separately from readiness',
    (working) => {
      expect(
        parseSkillagerProjectStatus(
          doctor(10, working),
          10,
          localPath('/workspace'),
          'codex',
        ),
      ).toMatchObject({ canProceed: false, working })
    },
  )
  it('refuses an ascended project root and mismatched agent/exit/schema, while accepting diagnostic readiness differences', () => {
    expect(() =>
      parseSkillagerProjectStatus(doctor(), 10, localPath('/workspace/nested'), 'codex'),
    ).toThrow('different project')
    expect(() =>
      parseSkillagerProjectStatus(doctor(), 10, localPath('/workspace'), 'claude'),
    ).toThrow()
    expect(() =>
      parseSkillagerProjectStatus(doctor(), 0, localPath('/workspace'), 'codex'),
    ).toThrow()
    expect(() =>
      parseSkillagerProjectStatus(
        { ...doctor(10), status: 'ready' },
        10,
        localPath('/workspace'),
        'codex',
      ),
    ).toThrow()
    const contradictory = doctor(0)
    contradictory.state.review.needed = 1
    expect(() =>
      parseSkillagerProjectStatus(contradictory, 0, localPath('/workspace'), 'codex'),
    ).toThrow()
    expect(() =>
      parseSkillagerProjectStatus(
        { ...doctor(), schema: 'unknown' },
        10,
        localPath('/workspace'),
        'codex',
      ),
    ).toThrow()
    expect(
      parseSkillagerProjectStatus(
        { ...doctor(13), readiness: { can_proceed: true } },
        13,
        localPath('/workspace'),
        'codex',
      ).canProceed,
    ).toBe(false)
  })
})
