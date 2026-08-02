import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  env?: Record<string, string>
  if?: string
  name: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface WorkflowJob {
  steps: WorkflowStep[]
}

interface WorkflowDocument {
  jobs: Record<string, WorkflowJob>
}

const ci = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as WorkflowDocument
const release = parse(
  readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as WorkflowDocument

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

function expectFailureUpload(
  step: WorkflowStep,
  artifactName: string,
  condition = 'failure()',
): void {
  expect(step.if).toBe(condition)
  expect(step.uses).toBe('actions/upload-artifact@v7')
  expect(step.with).toEqual({
    name: artifactName,
    path: '${{ runner.temp }}/hvir-smoke-artifacts',
    'if-no-files-found': 'ignore',
    'retention-days': 7,
  })
}

describe('required Electron smoke failure retention', () => {
  it('gives every required CI launcher invocation a unique destination', () => {
    const electron = ci.jobs['electron-smoke']!
    expect(requireStep(electron, 'Run production Electron workflow')).toMatchObject({
      env: {
        HVIR_SMOKE_ARTIFACT_DIR: '${{ runner.temp }}/hvir-smoke-artifacts/production',
      },
      run: 'xvfb-run -a npm run smoke',
    })
    expect(
      requireStep(electron, 'Run development renderer Performance Timeline containment'),
    ).toMatchObject({
      env: {
        HVIR_SMOKE_ARTIFACT_DIR:
          '${{ runner.temp }}/hvir-smoke-artifacts/development-performance',
      },
      run: 'xvfb-run -a npm run smoke:development-performance',
    })
    expectFailureUpload(
      requireStep(electron, 'Upload bounded Electron failure evidence'),
      'ci-electron-smoke-failure-${{ github.run_attempt }}',
    )

    const capacity = ci.jobs['capacity-smoke']!
    expect(
      requireStep(capacity, 'Run capacity contracts and collect performance evidence'),
    ).toMatchObject({
      env: {
        HVIR_SMOKE_ARTIFACT_DIR: '${{ runner.temp }}/hvir-smoke-artifacts/capacity',
      },
      run: 'xvfb-run -a npm run smoke:capacity',
    })
    expectFailureUpload(
      requireStep(capacity, 'Upload bounded capacity failure evidence'),
      'ci-capacity-smoke-failure-${{ github.run_attempt }}',
    )

    const macos = ci.jobs['macos-electron-smoke']!
    expect(requireStep(macos, 'Run focused unpackaged Electron scenarios')).toMatchObject(
      {
        env: {
          HVIR_SMOKE_ARTIFACT_DIR: '${{ runner.temp }}/hvir-smoke-artifacts/macos-ci',
        },
        run: 'npm run smoke:macos:ci',
      },
    )
    expectFailureUpload(
      requireStep(macos, 'Upload bounded macOS Electron failure evidence'),
      'ci-macos-electron-smoke-failure-${{ github.run_attempt }}',
    )
  })

  it('does not rerun Electron or generic verification during version-bump preparation', () => {
    const prepare = release.jobs.prepare!
    const preparationSteps = prepare.steps.map((step) => step.name)
    expect(preparationSteps).not.toContain('Install dependencies')
    expect(preparationSteps).not.toContain('Verify release source')
    expect(preparationSteps).not.toContain(
      'Exercise unpackaged Electron production workflow',
    )
    expect(preparationSteps).not.toContain('Upload bounded Electron failure evidence')
  })
})
