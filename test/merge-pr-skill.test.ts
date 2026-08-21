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

  it('accepts only a pull request number and delegates identity policy', () => {
    expect(skill).toContain('`$hvir-merge-pr <pull-request-number>`')
    expect(skill).toContain(
      'the pull request number is the only accepted maintainer input',
    )
    expect(skill).toContain('Do not request or accept a separately supplied issue number')
    expect(skill).toContain('npm run issue:merge -- --pull-request <pr> --json')
    expect(skill).toContain('npm run issue:merge -- --pull-request <pr> --apply --json')
    expect(skill).toContain('do not recreate its policy with ad hoc `gh`')
  })

  it('keeps review and epic integration outside ordinary merge authority', () => {
    expect(skill).toContain('Do not invoke `hvir-review-code`')
    expect(skill).toContain('this skill opens no measurement run')
    expect(skill).toContain('Never merge an epic child or cumulative epic pull request')
    expect(skill).toContain('direct the maintainer to')
    expect(skill).toContain('`hvir-implement-epic`')
  })

  it('preserves PR-number-only recovery after a partial post-merge result', () => {
    expect(skill).toContain('rerun the same PR-number-only dry-run/apply')
    expect(skill).toContain('skips a proven')
    expect(skill).toContain('existing merge')
    expect(skill).toContain('the exact PR-number retry invocation')
  })
})
