import { lstatSync, readFileSync, readlinkSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const skill = readFileSync(
  new URL('../.claude/skills/hvir-merge-pr/SKILL.md', import.meta.url),
  'utf8',
)

describe('hvir ordinary merge skill', () => {
  it('is exposed through Claude and Codex-compatible skill paths', () => {
    const codexPath = new URL('../.agents/skills/hvir-merge-pr', import.meta.url)
    expect(lstatSync(codexPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(codexPath)).toBe('../../.claude/skills/hvir-merge-pr')
    expect(skill).toContain('name: hvir-merge-pr')
  })

  it('requires explicit immutable authority and delegates policy to the repository owner', () => {
    expect(skill).toContain(
      'Require the maintainer to name the governing issue, pull request, and full',
    )
    expect(skill).toContain('npm run issue:merge -- --issue <issue> --pull-request <pr>')
    expect(skill).toContain('--candidate <full-candidate-sha> --apply --json')
    expect(skill).toContain('do not recreate its policy with ad hoc `gh`')
  })

  it('keeps review and epic integration outside ordinary merge authority', () => {
    expect(skill).toContain('Do not invoke `hvir-review-code`')
    expect(skill).toContain('this skill opens no measurement run')
    expect(skill).toContain('Never merge an epic child or cumulative epic pull request')
    expect(skill).toContain('direct the maintainer to')
    expect(skill).toContain('`hvir-implement-epic`')
  })

  it('preserves the idempotent recovery tuple after a partial post-merge result', () => {
    expect(skill).toContain('rerun the same dry-run/apply sequence')
    expect(skill).toContain('skips a proven existing merge')
    expect(skill).toContain('the exact idempotent retry tuple')
  })
})
