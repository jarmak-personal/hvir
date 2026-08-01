import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  new URL('../.github/workflows/smoke-stress.yml', import.meta.url),
  'utf8',
)

interface WorkflowStep {
  env?: Record<string, string>
  if?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

const parsed = parse(workflow) as {
  on: {
    workflow_dispatch: {
      inputs: {
        scenario: { options: string[] }
        repeat: { options: string[] }
      }
    }
  }
  permissions: Record<string, string>
  jobs: {
    stress: {
      env: Record<string, string>
      strategy: {
        'fail-fast': boolean
        matrix: { os: string[] }
      }
      steps: WorkflowStep[]
    }
  }
}

describe('Electron smoke stress workflow', () => {
  it('keeps focused stress evidence manual, bounded, and off recurring triggers', () => {
    expect(Object.keys(parsed.on)).toEqual(['workflow_dispatch'])
    expect(parsed.on).not.toHaveProperty('schedule')
    expect(parsed.on).not.toHaveProperty('pull_request')
    expect(parsed.on).not.toHaveProperty('push')
    expect(parsed.on.workflow_dispatch.inputs.scenario.options).toContain(
      'renderer-authority',
    )
    expect(parsed.on.workflow_dispatch.inputs.repeat.options).toEqual(['5', '10', '20', '50'])
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(parsed.jobs.stress.strategy['fail-fast']).toBe(false)
    expect(parsed.jobs.stress.strategy.matrix.os).toEqual(['ubuntu-24.04', 'macos-15'])
    expect(parsed.jobs.stress.env).toEqual({
      HVIR_SMOKE_SCENARIO: '${{ inputs.scenario }}',
      HVIR_SMOKE_REPEAT: '${{ inputs.repeat }}',
    })
  })

  it('uploads only bounded failure artifacts for failed jobs', () => {
    const runSteps = parsed.jobs.stress.steps.filter((step) => step.run)
    expect(runSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: "runner.os == 'Linux'",
          env: {
            HVIR_SMOKE_ARTIFACT_DIR: '${{ runner.temp }}/hvir-smoke-artifacts',
          },
          run: 'xvfb-run -a npm run smoke:scenario',
        }),
        expect.objectContaining({
          if: "runner.os == 'macOS'",
          env: {
            HVIR_SMOKE_ARTIFACT_DIR: '${{ runner.temp }}/hvir-smoke-artifacts',
          },
          run: 'npm run smoke:scenario',
        }),
      ]),
    )

    const upload = parsed.jobs.stress.steps.find(
      (step) => step.uses === 'actions/upload-artifact@v7',
    )
    expect(upload?.if).toBe('failure()')
    expect(upload?.with).toMatchObject({
      path: '${{ runner.temp }}/hvir-smoke-artifacts',
      'if-no-files-found': 'ignore',
      'retention-days': 7,
    })
  })
})
