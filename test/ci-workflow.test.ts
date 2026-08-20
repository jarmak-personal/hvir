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
  container?: {
    image: string
    options?: string
  }
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

  it('leaves native package certification and assembly to the release lifecycle', () => {
    expect(workflow.jobs['packaged-smoke']).toBeUndefined()
    for (const id of [
      'native-linux-package',
      'native-linux-ubuntu-24',
      'native-linux-debian',
      'native-macos-package',
      'native-release-assembly',
      'signed-macos-epic-acceptance',
    ]) {
      expect(workflow.jobs[id]).toBeUndefined()
    }
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
