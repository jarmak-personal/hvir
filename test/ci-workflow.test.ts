import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)

interface WorkflowJob {
  name: string
  needs?: string | string[]
  steps: Array<{
    name: string
    run?: string
    uses?: string
    with?: Record<string, unknown>
  }>
}

const workflow = parse(workflowSource) as {
  concurrency: {
    group: string
    'cancel-in-progress': boolean
  }
  jobs: Record<string, WorkflowJob>
}

const linuxChecks = [
  {
    id: 'verify',
    name: 'Verification (Linux)',
    command: 'npm run verify',
    fetchDepth: undefined,
  },
  {
    id: 'electron-smoke',
    name: 'Electron smoke (Linux)',
    command: 'xvfb-run -a npm run smoke',
    fetchDepth: 0,
  },
  {
    id: 'capacity-smoke',
    name: 'Capacity smoke (Linux)',
    command: 'xvfb-run -a npm run smoke:capacity',
    fetchDepth: 0,
  },
] as const

describe('CI workflow', () => {
  it('runs verification, Electron smoke, and capacity as independent Linux checks', () => {
    for (const expected of linuxChecks) {
      const job = workflow.jobs[expected.id]
      if (!job) {
        throw new Error(`Missing CI job: ${expected.id}`)
      }

      expect(job.name).toBe(expected.name)
      expect(job.needs).toBeUndefined()
      expect(job.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ run: 'npm ci' }),
          expect.objectContaining({ run: expected.command }),
        ]),
      )

      const checkout = job.steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      )
      expect(checkout?.with?.['fetch-depth']).toBe(expected.fetchDepth)
    }
  })

  it('keeps cancellation scoped to the current pull request or branch', () => {
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
