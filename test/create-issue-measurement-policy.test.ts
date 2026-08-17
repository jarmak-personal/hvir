import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const planningReference = readFileSync(
  new URL(
    '../.claude/skills/hvir-create-issue/references/issue-planning-measurement.md',
    import.meta.url,
  ),
  'utf8',
)

describe('create-issue planning measurement policy', () => {
  it('delegates shared recording and canonical field policy to their owners', () => {
    expect(planningReference).toContain(
      '[shared agent-work recording procedure](../../hvir-implement-issue/references/agent-work-recording.md)',
    )
    expect(planningReference).toContain(
      '[Agent-work Project projections](../../../../docs/project-management.md#agent-work-project-projections)',
    )
    expect(planningReference).not.toContain('Own lifecycle tokens')
    expect(planningReference).not.toContain(
      'This clears a stale Rollup from an ordinary issue or epic child.',
    )
  })

  it('retains the pending locator and separate preview and publication approvals', () => {
    expect(planningReference).toContain(
      '--issue pending --phase issue-planning --provider "$planning_provider"',
    )
    expect(planningReference).toContain(
      'Stop after the preview and wait for separate publication approval.',
    )
    expect(planningReference).toContain('Create the exact approved issue once.')
  })
})
