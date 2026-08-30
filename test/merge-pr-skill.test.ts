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
const projectManagement = readFileSync(
  new URL('../docs/project-management.md', import.meta.url),
  'utf8',
)
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8')

describe('hvir pull-request merge skill', () => {
  it('is exposed through Claude and Codex-compatible skill paths', () => {
    const codexPath = new URL('../.agents/skills/hvir-merge-pr', import.meta.url)
    expect(lstatSync(codexPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(codexPath)).toBe('../../.claude/skills/hvir-merge-pr')
    expect(skill).toContain('name: hvir-merge-pr')
  })

  it('resolves explicit or one handed-off pull request without repository discovery', () => {
    expect(skill).toContain('Use the number supplied by the maintainer')
    expect(skill).toContain('latest verified lifecycle handoff in the active interaction')
    expect(skill).toContain('Ask for one pull-request number')
    expect(skill).toContain('Never search branches, issues, the Project')
    expect(skill).toContain('do not request a separate issue number or candidate SHA')
  })

  it('uses GitHub protected auto-merge without a second classifier', () => {
    expect(skill).toContain('gh pr view <pr> --json baseRefName')
    expect(skill).toContain('delivery-route guard')
    expect(skill).toContain('gh pr merge <pr> --merge --auto')
    expect(skill).toContain('Never use `--admin`')
    expect(skill).toContain('repository ruleset')
    expect(skill).toContain('Monitor the accepted pull request')
    expect(skill).not.toContain('npm run issue:merge')
    expect(skill).not.toContain('repository-owned read-only classifier')
  })

  it('reconciles only focused Project owners after GitHub records the merge', () => {
    expect(skill).toContain('native closing relationships')
    expect(skill).toContain('npm run project:record -- --issue <issue>')
    expect(skill).toContain('npm run project:measure -- --issue <issue> --project --apply')
    expect(skill).toContain('For a root epic, also apply its existing non-recursive Rollup')
    expect(skill).toContain('merge-phase work, review usage')
    expect(skill).toContain('cleanup is not merge admission')
  })

  it('keeps epic-child integration and optional cleanup with the epic owner', () => {
    expect(skill).toContain('pull requests remain integrated only by')
    expect(epicSkill).toContain('pull-request acceptance remains the small')
    expect(epicSkill).toContain('Resume bounded post-merge cleanup')
    expect(epicSkill).toContain('Cleanup is not part of merge admission')
    expect(epicSkill).toContain('run performs no merge')
    expect(epicSkill).not.toContain('internal `$hvir-merge-pr` transfer')
  })

  it('documents and enforces removal of the bespoke merge coordinator', () => {
    expect(agents).toContain('explicit `hvir-merge-pr` invocation is the approval')
    expect(contributing).toContain('gh pr merge <pr> --merge --auto')
    expect(contributing).toContain('Auto-merge allows a candidate')
    expect(projectManagement).toContain('Repository tooling does not duplicate')
    expect(packageJson).not.toContain('"issue:merge"')
  })
})
