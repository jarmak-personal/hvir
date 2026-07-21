import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/project-pr-planning.yml', import.meta.url),
  'utf8',
)

function matches(pattern: RegExp): string[] {
  return [...workflow.matchAll(pattern)].map((match) => match[0])
}

describe('PR planning workflow security', () => {
  it('uses immutable third-party actions and trusted main automation only', () => {
    const actionReferences = matches(/^\s+uses: actions\/[^\s#]+/gm)
    expect(actionReferences).toHaveLength(4)
    for (const reference of actionReferences) {
      expect(reference.trim()).toMatch(
        /^uses: actions\/(checkout|setup-node)@[0-9a-f]{40}$/,
      )
    }
    expect(matches(/^\s+ref: main$/gm)).toHaveLength(2)
    expect(matches(/^\s+persist-credentials: false$/gm)).toHaveLength(2)
  })

  it('never checks out, fetches, installs, or executes pull-request code', () => {
    expect(workflow).not.toMatch(/head\.sha|head_ref|refs\/pull|gh pr checkout/)
    expect(workflow).not.toMatch(/^\s+run:.*(?:npm (?:ci|install)|git fetch)/gm)
    expect(matches(/^\s+run: npm run project:pr$/gm)).toHaveLength(2)
    expect(workflow).not.toMatch(/^\s+run:.*\$\{\{/m)
  })

  it('passes event values only through environment variables with read-only permissions', () => {
    expect(workflow).toContain(
      'HVIR_PULL_REQUEST_NUMBER: ${{ github.event.pull_request.number }}',
    )
    expect(workflow).toContain('HVIR_ISSUE_NUMBER: ${{ github.event.issue.number }}')
    expect(workflow).toContain(
      'HVIR_PREVIOUS_PR_BODY: ${{ github.event.changes.body.from }}',
    )
    expect(workflow).toContain('HVIR_REPO_TOKEN: ${{ github.token }}')
    expect(workflow).toContain('pull-requests: read')
    expect(workflow).toContain('issues: read')
    expect(workflow).not.toMatch(/issues: write|pull-requests: write|contents: write/)
  })

  it('gates every secret-bearing job on the main-only environment', () => {
    expect(matches(/^\s+name: project-automation$/gm)).toHaveLength(2)
    expect(matches(/^\s+deployment: false$/gm)).toHaveLength(2)
    expect(workflow).toContain("github.event.pull_request.base.ref == 'main'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
  })
})
