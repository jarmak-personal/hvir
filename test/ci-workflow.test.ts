import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const releaseValidatorSource = readFileSync(
  new URL('../scripts/validate-release-pr.mts', import.meta.url),
  'utf8',
)

interface WorkflowJob {
  if?: string
  name: string
  'runs-on': string
  needs?: string | string[]
  permissions?: Record<string, string>
  strategy?: {
    'fail-fast': boolean
    matrix: {
      include: Array<Record<string, string>>
    }
  }
  steps: Array<{
    env?: Record<string, string>
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
const codeqlWorkflow = parse(
  readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8'),
) as { jobs: Record<string, WorkflowJob> }

const fullCiCondition = "always() && needs.release-version-integrity.result == 'skipped'"
const nativeAssemblyCondition = [
  'always()',
  "needs.native-linux-package.result == 'success'",
  "needs.native-macos-package.result == 'success'",
].join(' && ')
const releasePrIdentityCondition = [
  "github.event_name == 'pull_request'",
  "github.actor == 'github-actions[bot]'",
  "github.event.pull_request.user.login == 'github-actions[bot]'",
  'github.event.pull_request.base.ref == github.event.repository.default_branch',
  'github.event.pull_request.head.repo.full_name == github.repository',
  "startsWith(github.event.pull_request.head.ref, 'release/v')",
].join(' && ')
const ordinaryCodeqlCondition = [
  "github.event_name != 'pull_request'",
  "github.actor != 'github-actions[bot]'",
  "github.event.pull_request.user.login != 'github-actions[bot]'",
  'github.event.pull_request.base.ref != github.event.repository.default_branch',
  'github.event.pull_request.head.repo.full_name != github.repository',
  "!startsWith(github.event.pull_request.head.ref, 'release/v')",
].join(' || ')
const releaseValidatorCheckout = [
  'scripts/validate-release-pr.mts',
  ...[...releaseValidatorSource.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(
    (match) => `scripts/${match[1]}`,
  ),
].join('\n')

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
      expect(job.needs).toBe('release-version-integrity')
      expect(job.if).toBe(fullCiCondition)
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

  it('temporarily runs only the stable macOS correctness subset', () => {
    const job = workflow.jobs['macos-electron-smoke']
    if (!job) throw new Error('Missing CI job: macos-electron-smoke')
    expect(job.name).toBe('Electron correctness (macOS arm64; temporary reduced gate)')
    expect(job['runs-on']).toBe('macos-15')
    expect(job.needs).toBe('release-version-integrity')
    expect(job.if).toBe(fullCiCondition)
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'npm ci' }),
        expect.objectContaining({ run: 'npm run smoke:macos:ci' }),
      ]),
    )
    const commands = job.steps.flatMap((step) => (step.run ? [step.run] : []))
    expect(commands).toEqual(['npm ci', 'npm run smoke:macos:ci'])
  })

  it('retires npm payload smoke and keeps native acceptance on both Linux architectures', () => {
    expect(workflow.jobs['packaged-smoke']).toBeUndefined()
    const job = workflow.jobs['native-linux-package']
    if (!job) throw new Error('Missing CI job: native-linux-package')
    expect(job.name).toBe('Native package acceptance (${{ matrix.name }})')
    expect(job.needs).toBe('release-version-integrity')
    expect(job.if).toBe(fullCiCondition)
    expect(job.strategy?.['fail-fast']).toBe(false)
    expect(job.strategy?.matrix.include).toEqual([
      {
        name: 'Linux x64',
        os: 'ubuntu-24.04',
        build: 'npm run pack:linux:x64',
        deb_arch: 'amd64',
        release_arch: 'x64',
        artifact: 'dist/hvir-*-linux-x64.deb',
      },
      {
        name: 'Linux arm64',
        os: 'ubuntu-24.04-arm',
        build: 'npm run pack:linux:arm64',
        deb_arch: 'arm64',
        release_arch: 'arm64',
        artifact: 'dist/hvir-*-linux-arm64.deb',
      },
    ])
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'xvfb-run -a npm run smoke:linux:installed' }),
        expect.objectContaining({
          name: 'Give the accepted artifact its public release name',
        }),
      ]),
    )
  })

  it('assembles the accepted native matrix without publishing from pull-request CI', () => {
    const job = workflow.jobs['native-release-assembly']
    if (!job) throw new Error('Missing CI job: native-release-assembly')
    expect(job.name).toBe('Native release assembly (unsigned structure)')
    expect(job.needs).toEqual(['native-linux-package', 'native-macos-package'])
    expect(job.if).toBe(nativeAssemblyCondition)
    const commands = job.steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain('npm run assemble:native-release')
    expect(commands).toContain('bash -n dist/release/install.sh')
    expect(commands).toContain('sha256sum --check SHA256SUMS')
    expect(commands).not.toContain('hvir_${version}_amd64.deb')
    expect(commands).not.toContain('hvir_${version}_arm64.deb')
    expect(commands).not.toMatch(/gh release (?:create|upload|edit)/)
  })

  it('uses one trusted release classifier and preserves ordinary CI and CodeQL', () => {
    const integrity = workflow.jobs['release-version-integrity']
    if (!integrity) throw new Error('Missing CI job: release-version-integrity')
    expect(integrity.if).toBe(releasePrIdentityCondition)
    expect(integrity.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    })
    expect(integrity.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Check out trusted release validation',
          uses: 'actions/checkout@v7',
          with: {
            ref: '${{ github.event.pull_request.base.sha }}',
            'persist-credentials': false,
            'sparse-checkout': releaseValidatorCheckout,
            'sparse-checkout-cone-mode': false,
          },
        }),
        expect.objectContaining({
          name: 'Validate version-only release change',
          run: 'node scripts/validate-release-pr.mts',
        }),
      ]),
    )

    for (const id of [
      'verify',
      'electron-smoke',
      'capacity-smoke',
      'macos-electron-smoke',
      'native-linux-package',
      'native-macos-package',
    ]) {
      expect(workflow.jobs[id]).toMatchObject({
        needs: 'release-version-integrity',
        if: fullCiCondition,
      })
    }
    expect(codeqlWorkflow.jobs.analyze?.if).toBe(ordinaryCodeqlCondition)
  })

  it('keeps cancellation scoped to the current pull request or branch', () => {
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
