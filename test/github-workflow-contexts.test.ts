import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { validateWorkflowEnvironmentContexts } from './github-workflow-contexts'

const workflowDirectory = new URL('../.github/workflows/', import.meta.url)

describe('GitHub workflow context availability', () => {
  it('parses every repository workflow and accepts its environment contexts', () => {
    const errors = readdirSync(workflowDirectory)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort()
      .flatMap((name) => {
        const source = readFileSync(new URL(name, workflowDirectory), 'utf8')
        return validateWorkflowEnvironmentContexts(source).map(
          (error) => `${name}: ${error}`,
        )
      })

    expect(errors).toEqual([])
  })

  it('rejects runner context before a job has reached a runner', () => {
    const source = `
name: Invalid job environment
on: workflow_dispatch
jobs:
  acceptance:
    runs-on: ubuntu-24.04
    env:
      ARTIFACT_DIR: \${{ runner.temp }}/artifacts
    steps:
      - run: npm test
`

    expect(validateWorkflowEnvironmentContexts(source)).toEqual([
      'jobs.acceptance.env.ARTIFACT_DIR uses the unavailable runner context',
    ])
  })
})
