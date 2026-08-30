import { lstatSync, readFileSync, readlinkSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const skill = readFileSync(
  new URL('../.claude/skills/hvir-merge-pr/SKILL.md', import.meta.url),
  'utf8',
)
const epicSkill = readFileSync(
  new URL('../.claude/skills/hvir-implement-epic/SKILL.md', import.meta.url),
  'utf8',
)
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')

describe('hvir final-candidate merge skill', () => {
  it('is exposed through Claude and Codex-compatible skill paths', () => {
    const codexPath = new URL('../.agents/skills/hvir-merge-pr', import.meta.url)
    expect(lstatSync(codexPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(codexPath)).toBe('../../.claude/skills/hvir-merge-pr')
    expect(skill).toContain('name: hvir-merge-pr')
  })

  it('resolves explicit or one exact handed-off pull request without repository discovery', () => {
    expect(skill).toContain('When the invocation includes one pull-request number')
    expect(skill).toContain('latest verified lifecycle handoff in the')
    expect(skill).toContain('active interaction identifies exactly one pull request')
    expect(skill).toContain('stop and ask the maintainer for one pull-request number')
    expect(skill).toContain('Never search the repository')
    expect(skill).toContain('ambiguous handoff does not authorize a best guess')
    expect(skill).toContain('Do not request or accept a separately supplied issue number')
  })

  it('classifies read-only before using the ordinary merge owner', () => {
    expect(skill).toContain('npm run issue:merge -- --pull-request <pr> --json')
    expect(skill).toContain('npm run issue:merge -- --pull-request <pr> --apply --json')
    expect(skill).toContain('repository-owned read-only classifier')
    expect(skill).toContain('Do not recreate its relationship')
    expect(skill).toContain(
      'ordinary pull request with a clean `would-merge` or `would-reconcile`',
    )
  })

  it('transfers only a qualified cumulative root epic and keeps children blocked', () => {
    expect(skill).toContain('Do not invoke `hvir-review-code`')
    expect(skill).toContain('this skill opens no measurement run')
    expect(skill).toContain('has no diagnostic except `issue-not-ordinary`')
    expect(skill).toContain(
      'Pass the resolved pull-request number and candidate identity internally',
    )
    expect(skill).toContain('maintainer to invoke another skill')
    expect(skill).toContain('Never merge an epic child from this skill')
    expect(skill).toContain(
      'Never route merely because `issue-not-ordinary` appears alongside',
    )
    expect(skill).toContain('opens and records its one resumed cleanup run')
  })

  it('preserves PR-number-only recovery after a partial post-merge result', () => {
    expect(skill).toContain('rerun the same PR-number-only dry-run/apply')
    expect(skill).toContain('skips a proven')
    expect(skill).toContain('existing merge')
    expect(skill).toContain('the exact PR-number retry invocation')
  })

  it('gives the epic owner an exact acceptance and cleanup transfer contract', () => {
    expect(epicSkill).toContain('`hvir-merge-pr` may transfer one resolved')
    expect(epicSkill).toContain(
      'Do not delegate children or repeat cumulative implementation',
    )
    expect(epicSkill).toContain('Accept and clean an exact cumulative candidate')
    expect(epicSkill).toContain('current head equals the transferred full candidate SHA')
    expect(epicSkill).toContain('every native direct child is closed')
    expect(epicSkill).toContain(
      'worktree is registered on that branch, clean, and at the exact',
    )
    expect(epicSkill).toContain("GitHub's normal merge API")
    expect(epicSkill).toContain('with an exact-head guard')
    expect(epicSkill).toContain('do not invent merge-phase or review usage')
    expect(epicSkill).toContain('skips a proven merge and resumes closure')
  })

  it('documents the unified final-acceptance entry path for contributors', () => {
    expect(agents).toContain('Final acceptance is separately authorized')
    expect(agents).toContain('latest verified lifecycle handoff')
    expect(agents).toContain('internal cumulative-epic transfer')
    expect(contributing).toContain('## Accept final delivery')
    expect(contributing).toContain('It never searches repository state')
    expect(contributing).toContain('The maintainer does not invoke a second skill')
    expect(contributing).toContain('records only the resumed cleanup run')
  })
})
