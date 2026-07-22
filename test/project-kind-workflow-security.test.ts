import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/project-kind.yml', import.meta.url),
  'utf8',
)

function matches(pattern: RegExp): string[] {
  return [...workflow.matchAll(pattern)].map((match) => match[0])
}

describe('project kind workflow security', () => {
  it('uses only immutable third-party action references', () => {
    const actionReferences = matches(/^\s+uses: actions\/[^\s#]+/gm)

    expect(actionReferences).toHaveLength(4)
    for (const reference of actionReferences) {
      expect(reference.trim()).toMatch(
        /^uses: actions\/(checkout|setup-node)@[0-9a-f]{40}$/,
      )
    }
  })

  it('always checks out trusted automation without persisting credentials', () => {
    expect(matches(/^\s+ref: main$/gm)).toHaveLength(2)
    expect(matches(/^\s+persist-credentials: false$/gm)).toHaveLength(2)
  })

  it('gates secret-bearing jobs on the main-only environment', () => {
    expect(matches(/^\s+name: project-automation$/gm)).toHaveLength(2)
    expect(matches(/^\s+deployment: false$/gm)).toHaveLength(2)
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
  })

  it('does not execute pull request content or interpolate event data into shell source', () => {
    expect(workflow).not.toMatch(/^\s+(pull_request|pull_request_target|workflow_run):/m)
    expect(matches(/^\s+run: npm run project:kind$/gm)).toHaveLength(2)
    expect(workflow).not.toMatch(/^\s+run:.*\$\{\{/m)
  })

  it('converges issue lifecycle and label events without polling', () => {
    expect(workflow).toContain('types: [opened, reopened, closed, labeled, unlabeled]')
    expect(workflow).toContain("github.event.action == 'closed'")
    expect(workflow).not.toMatch(/^\s+(schedule):/m)
  })
})
