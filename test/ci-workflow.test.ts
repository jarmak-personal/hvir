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
    fetchDepth: undefined,
  },
  {
    id: 'capacity-smoke',
    name: 'Capacity contracts + performance evidence (Linux)',
    command: 'xvfb-run -a npm run smoke:capacity',
    fetchDepth: undefined,
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

  it('separates macOS correctness from capacity evidence without a hosted budget gate', () => {
    const job = workflow.jobs['macos-electron-smoke']
    if (!job) throw new Error('Missing CI job: macos-electron-smoke')
    expect(job.name).toBe('Electron correctness + capacity evidence (macOS arm64)')
    expect(job['runs-on']).toBe('macos-15')
    expect(job.needs).toBeUndefined()
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'npm ci' }),
        expect.objectContaining({ run: 'npm run smoke:macos' }),
        expect.objectContaining({ run: 'npm run smoke:capacity' }),
      ]),
    )
    expect(job.steps.map((step) => step.run ?? '').join('\n')).not.toContain(
      'performance:capacity',
    )
  })

  it('retires npm payload smoke and keeps native acceptance on both Linux architectures', () => {
    expect(workflow.jobs['packaged-smoke']).toBeUndefined()
    const job = workflow.jobs['native-linux-package']
    if (!job) throw new Error('Missing CI job: native-linux-package')
    expect(job.name).toBe('Native package acceptance (${{ matrix.name }})')
    expect(job.strategy?.['fail-fast']).toBe(false)
    expect(job.strategy?.matrix.include).toEqual([
      {
        name: 'Linux x64',
        os: 'ubuntu-24.04',
        build: 'npm run pack:linux:x64',
        artifact: 'dist/hvir_*_amd64.deb',
      },
      {
        name: 'Linux arm64',
        os: 'ubuntu-24.04-arm',
        build: 'npm run pack:linux:arm64',
        artifact: 'dist/hvir_*_arm64.deb',
      },
    ])
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'xvfb-run -a npm run smoke:linux:installed' }),
      ]),
    )
  })

  it('assembles the accepted native matrix without publishing from pull-request CI', () => {
    const job = workflow.jobs['native-release-assembly']
    if (!job) throw new Error('Missing CI job: native-release-assembly')
    expect(job.name).toBe('Native release assembly (unsigned structure)')
    expect(job.needs).toEqual(['native-linux-package', 'native-macos-package'])
    const commands = job.steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain('npm run assemble:native-release')
    expect(commands).toContain('bash -n dist/release/install.sh')
    expect(commands).toContain('sha256sum --check SHA256SUMS')
    expect(commands).not.toMatch(/gh release (?:create|upload|edit)/)
  })

  it('keeps cancellation scoped to the current pull request or branch', () => {
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
