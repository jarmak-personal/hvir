import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'

const workflowSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const codeqlSource = readFileSync(
  new URL('../.github/workflows/codeql.yml', import.meta.url),
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
  steps: Array<{
    env?: Record<string, string>
    name: string
    run?: string
    uses?: string
    with?: Record<string, unknown>
  }>
}

const workflow = parse(workflowSource) as {
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, WorkflowJob>
}
const codeqlWorkflow = parse(codeqlSource) as {
  jobs: Record<string, WorkflowJob>
}

const ordinaryCondition =
  "always() && needs.release-version-integrity.result == 'skipped'"
const releasePrIdentityCondition = [
  "github.event_name == 'pull_request'",
  "github.actor == 'github-actions[bot]'",
  "github.event.pull_request.user.login == 'github-actions[bot]'",
  'github.event.pull_request.base.ref == github.event.repository.default_branch',
  'github.event.pull_request.head.repo.full_name == github.repository',
  "startsWith(github.event.pull_request.head.ref, 'release/v')",
].join(' && ')
const releaseValidatorCheckout = [
  'scripts/validate-release-pr.mts',
  ...[...releaseValidatorSource.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(
    (match) => `scripts/${match[1]}`,
  ),
].join('\n')

const ordinaryJobs = [
  ['verify', 'Verification (Linux)', 'npm run verify'],
  ['electron-smoke', 'Electron smoke (Linux)', 'xvfb-run -a npm run smoke'],
  [
    'macos-electron-smoke',
    'Electron correctness (macOS arm64; temporary reduced gate)',
    'npm run smoke:macos:ci',
  ],
  ['codeql', 'CodeQL analysis', undefined],
] as const

describe('CI workflow', () => {
  it('runs only for pull-request candidates on main and epic branches', () => {
    expect(workflowSource).toMatch(/^on:\n {2}pull_request:\n/m)
    expect(workflowSource).toContain("      - 'epic/**'")
    expect(workflowSource).not.toMatch(/^ {2}push:/m)
  })

  it('tests every ordinary required job from the default merge-ref checkout', () => {
    for (const [id, name, command] of ordinaryJobs) {
      const job = workflow.jobs[id]
      if (!job) throw new Error(`Missing CI job: ${id}`)
      expect(job.name).toBe(name)
      expect(job.needs).toBe('release-version-integrity')
      expect(job.if).toBe(ordinaryCondition)
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      )
      expect(checkout).toBeDefined()
      expect(checkout?.with?.ref).toBeUndefined()
      if (command) {
        expect(job.steps).toEqual(
          expect.arrayContaining([expect.objectContaining({ run: command })]),
        )
      }
    }
    expect(workflow.jobs.codeql?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      packages: 'read',
      'security-events': 'write',
    })
  })

  it('keeps the exact version-only validator as the sole ordinary-job skip path', () => {
    const integrity = workflow.jobs['release-version-integrity']
    if (!integrity) throw new Error('Missing release version integrity job')
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
    for (const [id] of ordinaryJobs) {
      expect(workflow.jobs[id]).toMatchObject({
        needs: 'release-version-integrity',
        if: ordinaryCondition,
      })
    }
  })

  it('always reports one coherent-attempt aggregate and fails every incomplete branch', () => {
    const aggregate = workflow.jobs['merge-acceptance']
    if (!aggregate) throw new Error('Missing merge acceptance job')
    expect(aggregate.name).toBe('Merge acceptance')
    expect(aggregate.if).toBe('always()')
    expect(aggregate.permissions).toEqual({
      actions: 'read',
      contents: 'read',
    })
    expect(aggregate.needs).toEqual([
      'release-version-integrity',
      'verify',
      'electron-smoke',
      'macos-electron-smoke',
      'codeql',
    ])
    expect(aggregate.steps[0]).toEqual({
      name: 'Check out exact head for base ancestry proof',
      uses: 'actions/checkout@v7',
      with: {
        ref: '${{ github.event.pull_request.head.sha }}',
        'fetch-depth': 0,
        'persist-credentials': false,
      },
    })
    expect(aggregate.steps).toContainEqual({
      name: 'Require one coherent CI attempt',
      env: { GITHUB_TOKEN: '${{ github.token }}' },
      run: 'node scripts/ci-attempt-evidence.mts',
    })
    const step = aggregate.steps.find(
      (candidate) => candidate.name === 'Require exact candidate ancestry',
    )
    expect(step?.env).toEqual({
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    })
    expect(step?.run).toContain('if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$')
    expect(step?.run).toContain('if [ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]')
    expect(step?.run).toContain(
      'if ! git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA"',
    )
  })

  it('executes every candidate-identity acceptance branch', async () => {
    const aggregate = workflow.jobs['merge-acceptance']
    const script = aggregate?.steps.find(
      (candidate) => candidate.name === 'Require exact candidate ancestry',
    )?.run
    if (!script) throw new Error('Missing merge acceptance decision')

    const repository = await mkdtemp(join(tmpdir(), 'hvir-merge-acceptance-'))
    onTestFinished(() => rm(repository, { recursive: true, force: true }))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'ci@example.invalid')
    git('config', 'user.name', 'CI')
    git('commit', '--allow-empty', '-m', 'base')
    const baseSha = git('rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-m', 'head')
    const headSha = git('rev-parse', 'HEAD')
    git('switch', '--quiet', '--create', 'diverged', baseSha)
    git('commit', '--allow-empty', '-m', 'diverged')
    const divergedSha = git('rev-parse', 'HEAD')
    git('switch', '--quiet', '--detach', headSha)

    const ordinaryEnvironment = {
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
    }
    const runAggregate = (overrides: Record<string, string> = {}): number | null =>
      spawnSync('bash', ['-c', script], {
        cwd: repository,
        env: { ...process.env, ...ordinaryEnvironment, ...overrides },
      }).status

    expect(runAggregate()).toBe(0)
    const rejectedCases: Array<Record<string, string>> = [
      { BASE_SHA: divergedSha },
      { BASE_SHA: 'not-a-sha' },
      { HEAD_SHA: baseSha },
    ]
    for (const rejected of rejectedCases) {
      expect(runAggregate(rejected)).toBe(1)
    }
  })

  it('removes hosted capacity while retaining controlled capacity commands', () => {
    expect(workflow.jobs['capacity-smoke']).toBeUndefined()
    expect(workflowSource).not.toContain('npm run smoke:capacity')
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(packageJson.scripts['performance:capacity']).toBeDefined()
    expect(packageJson.scripts.gauntlet).toContain('phase8-gauntlet.sh')
  })

  it('leaves standalone CodeQL with scheduled security ownership only', () => {
    expect(codeqlSource).toMatch(/^on:\n {2}schedule:/m)
    expect(codeqlSource).not.toMatch(/^ {2}(push|pull_request|workflow_dispatch):/m)
    expect(codeqlWorkflow.jobs.analyze?.if).toBeUndefined()
    expect(codeqlWorkflow.jobs.analyze?.name).toBe('Analyze JavaScript and TypeScript')
  })

  it('records the comparable candidate and default-branch workload counts', () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(6)
    const dependencyInstalls = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.run === 'npm ci'),
    )
    expect(dependencyInstalls).toHaveLength(3)
    expect(workflowSource).not.toMatch(/^ {2}push:/m)
    expect(codeqlSource).not.toMatch(/^ {2}push:/m)
  })

  it('keeps cancellation scoped to the current pull request', () => {
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    })
  })
})
