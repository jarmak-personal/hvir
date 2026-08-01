import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  new URL('../.github/workflows/smoke-stress.yml', import.meta.url),
  'utf8',
)

interface WorkflowStep {
  id?: string
  env?: Record<string, string>
  if?: string
  run?: string
  uses?: string
  'continue-on-error'?: boolean
  with?: Record<string, unknown>
}

interface WorkflowJob {
  if?: string
  needs?: string | string[]
  'runs-on': string
  'timeout-minutes': number
  strategy?: {
    'fail-fast': boolean
    'max-parallel': number
    matrix: string
  }
  steps: WorkflowStep[]
}

const parsed = parse(workflow) as {
  on: {
    workflow_dispatch: { inputs: { source_sha: { required: boolean; type: string } } }
    schedule: unknown
  }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, WorkflowJob>
}

describe('Electron reliability qualification workflow', () => {
  it('fixes a reviewed SHA and plans qualification or weekly evidence', () => {
    expect(parsed.on.workflow_dispatch.inputs.source_sha).toMatchObject({
      required: true,
      type: 'string',
    })
    expect(parsed.on).toHaveProperty('schedule')
    expect(parsed.on).not.toHaveProperty('pull_request')
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(parsed.concurrency['cancel-in-progress']).toBe(false)

    const plan = parsed.jobs.plan!
    const checkout = plan.steps.find((step) => step.uses === 'actions/checkout@v7')
    const planStep = plan.steps.find((step) => step.id === 'plan')
    expect(checkout?.with?.ref).toBe('${{ github.sha }}')
    expect(planStep).toMatchObject({
      run: 'node scripts/run-electron-qualification.mts plan',
      env: {
        HVIR_QUALIFICATION_SOURCE_SHA: '${{ github.sha }}',
        HVIR_QUALIFICATION_RUN_ATTEMPT: '${{ github.run_attempt }}',
      },
    })
    expect(planStep?.env?.HVIR_QUALIFICATION_MODE).toContain("'weekly'")
    expect(planStep?.env?.HVIR_QUALIFICATION_REVIEWED_SHA).toContain('inputs.source_sha')
  })

  it('runs bounded non-retry partitions and always retains partial evidence', () => {
    const partition = parsed.jobs.partition!
    expect(partition['timeout-minutes']).toBe(90)
    expect(partition.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 12,
      matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}',
    })
    const invocation = partition.steps.find((step) => step.id === 'invoke')
    expect(invocation).toMatchObject({
      'continue-on-error': true,
      run: 'node scripts/run-electron-qualification.mts partition',
    })
    expect(invocation?.env).toMatchObject({
      HVIR_QUALIFICATION_SOURCE_SHA: '${{ needs.plan.outputs.source_sha }}',
      HVIR_QUALIFICATION_PLATFORM: '${{ matrix.platform }}',
      HVIR_QUALIFICATION_ATTEMPT_COUNT: '${{ matrix.attemptCount }}',
    })
    const upload = partition.steps.find(
      (step) => step.uses === 'actions/upload-artifact@v7',
    )
    expect(upload).toMatchObject({
      if: 'always()',
      with: {
        'if-no-files-found': 'error',
        'retention-days': 30,
      },
    })
    expect(partition.steps.at(-1)?.run).toBe(
      'node scripts/run-electron-qualification.mts assert-partition',
    )
  })

  it('summarizes every expected partition even when matrix jobs fail', () => {
    const summarize = parsed.jobs.summarize!
    expect(summarize.if).toBe("always() && needs.plan.result == 'success'")
    expect(summarize.needs).toEqual(['plan', 'partition'])
    expect(summarize.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uses: 'actions/download-artifact@v8' }),
        expect.objectContaining({
          id: 'summarize',
          'continue-on-error': true,
          run: 'node scripts/run-electron-qualification.mts summarize',
        }),
        expect.objectContaining({
          run: 'node scripts/run-electron-qualification.mts assert-summary',
        }),
      ]),
    )
    const upload = summarize.steps.find(
      (step) => step.uses === 'actions/upload-artifact@v7',
    )
    expect(upload?.with).toMatchObject({
      'if-no-files-found': 'error',
      'retention-days': 90,
    })
  })
})
