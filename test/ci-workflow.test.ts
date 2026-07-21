import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)

interface WorkflowJob {
  name: string
  'runs-on': string
  needs?: string | string[]
  strategy?: {
    'fail-fast': boolean
    matrix: {
      include: Array<Record<string, string>>
    }
  }
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
    fetchDepth: 0,
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

  it('runs the focused unpackaged Electron scenarios independently on macOS arm64', () => {
    const job = workflow.jobs['macos-electron-smoke']
    if (!job) throw new Error('Missing CI job: macos-electron-smoke')
    expect(job.name).toBe('Electron smoke (macOS arm64, unpackaged)')
    expect(job['runs-on']).toBe('macos-15')
    expect(job.needs).toBeUndefined()
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'npm ci' }),
        expect.objectContaining({ run: 'npm run smoke:macos' }),
      ]),
    )
  })

  it('retains packaged smoke on the three ADR-011 target architectures', () => {
    const job = workflow.jobs['packaged-smoke']
    if (!job) throw new Error('Missing CI job: packaged-smoke')
    expect(job.name).toBe('Packaged smoke (${{ matrix.name }})')
    expect(job.strategy?.['fail-fast']).toBe(false)
    expect(job.strategy?.matrix.include).toEqual([
      {
        name: 'Linux x64',
        os: 'ubuntu-24.04',
        build: 'npm run pack:npm:linux:x64',
        smoke: 'xvfb-run -a npm run smoke:packaged',
      },
      {
        name: 'Linux arm64',
        os: 'ubuntu-24.04-arm',
        build: 'npm run pack:npm:linux:arm64',
        smoke: 'xvfb-run -a npm run smoke:packaged',
      },
      {
        name: 'macOS arm64',
        os: 'macos-15',
        build: 'npm run pack:npm:mac:arm64',
        smoke: 'npm run smoke:packaged',
      },
    ])
  })

  it('keeps cancellation scoped to the current pull request or branch', () => {
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
