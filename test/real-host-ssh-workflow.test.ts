import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  new URL('../.github/workflows/real-host-ssh.yml', import.meta.url),
  'utf8',
)

interface WorkflowStep {
  env?: Record<string, string>
  id?: string
  if?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

const parsed = parse(workflow) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      environment?: string
      env?: Record<string, string>
      if?: string
      needs?: string
      steps: WorkflowStep[]
    }
  >
}

describe('real-host SSH workflow', () => {
  it('is manual/scheduled and never joins the pull-request gate', () => {
    expect(parsed.on).toHaveProperty('workflow_dispatch')
    expect(parsed.on).toHaveProperty('schedule')
    expect(parsed.on).not.toHaveProperty('pull_request')
    expect(parsed.permissions).toEqual({ contents: 'read' })
    expect(parsed.jobs.configuration?.environment).toBe('real-host-ssh')
    expect(parsed.jobs.acceptance?.environment).toBe('real-host-ssh')
  })

  it('skips absent infrastructure and fails partial configuration', () => {
    const configuration = parsed.jobs.configuration
    const classification = configuration?.steps.find(
      (step) => step.id === 'configuration',
    )
    expect(classification?.run).toContain("echo 'configured=false'")
    expect(classification?.run).toContain('acceptance is skipped')
    expect(classification?.run).toContain('partially configured')
    expect(classification?.run).toContain('exit 1')
    expect(parsed.jobs.acceptance).toMatchObject({
      needs: 'configuration',
      if: "needs.configuration.outputs.configured == 'true'",
    })
  })

  it('passes only explicit protected configuration and retains bounded failures', () => {
    const acceptance = parsed.jobs.acceptance
    expect(acceptance?.env).toMatchObject({
      HVIR_REAL_SSH_HOST: '${{ secrets.HVIR_REAL_SSH_HOST }}',
      HVIR_REAL_SSH_HOST_KEY: '${{ secrets.HVIR_REAL_SSH_HOST_KEY }}',
      HVIR_REAL_SSH_PRIVATE_KEY:
        '${{ secrets.HVIR_REAL_SSH_PRIVATE_KEY }}',
    })
    const exercise = acceptance?.steps.find(
      (step) => step.run === 'npm run acceptance:ssh:real-host',
    )
    expect(exercise?.env).toEqual({
      HVIR_REAL_SSH_ARTIFACT_DIR:
        '${{ runner.temp }}/hvir-real-host-ssh',
    })
    const upload = acceptance?.steps.find(
      (step) => step.uses === 'actions/upload-artifact@v7',
    )
    expect(upload?.if).toBe('failure()')
    expect(upload?.with).toMatchObject({
      path: '${{ runner.temp }}/hvir-real-host-ssh',
      'if-no-files-found': 'ignore',
      'retention-days': 7,
    })
  })
})
