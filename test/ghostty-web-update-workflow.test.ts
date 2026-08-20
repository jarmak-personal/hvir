import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  readonly env?: Record<string, string>
  readonly id?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, string | number | boolean>
}

interface Job {
  readonly environment?: { readonly deployment: boolean; readonly name: string }
  readonly needs?: string
  readonly permissions?: Record<string, string>
  readonly steps: readonly Step[]
}

const source = readFileSync(
  new URL('../.github/workflows/ghostty-web-update.yml', import.meta.url),
  'utf8',
)
const ciSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const codeqlSource = readFileSync(
  new URL('../.github/workflows/codeql.yml', import.meta.url),
  'utf8',
)
const planningSource = readFileSync(
  new URL('../.github/workflows/project-pr-planning.yml', import.meta.url),
  'utf8',
)
const dependabotSource = readFileSync(
  new URL('../.github/dependabot.yml', import.meta.url),
  'utf8',
)
const workflow = parse(source) as {
  readonly concurrency: { readonly 'cancel-in-progress': boolean; readonly group: string }
  readonly jobs: { readonly prepare: Job; readonly publish: Job }
  readonly on: {
    readonly schedule: Array<{ readonly cron: string }>
    workflow_dispatch: unknown
  }
  readonly permissions: Record<string, string>
}

describe('ghostty-web update workflow', () => {
  it('runs on one bounded schedule and manual dispatch without overlapping mutations', () => {
    expect(workflow.on.schedule).toHaveLength(1)
    expect(workflow.on.schedule[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/)
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.concurrency).toEqual({
      group: 'ghostty-web-update',
      'cancel-in-progress': false,
    })
  })

  it('keeps candidate execution outside the credentialed publication job', () => {
    const prepare = workflow.jobs.prepare
    const publish = workflow.jobs.publish
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(prepare.environment).toBeUndefined()
    expect(publish.environment).toEqual({
      name: 'ghostty-web-updates',
      deployment: false,
    })
    expect(publish.needs).toBe('prepare')
    expect(publish.permissions).toEqual({ actions: 'read', contents: 'read' })

    const prepareCheckout = prepare.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )
    expect(prepareCheckout?.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    })
    expect(prepare.steps.some((step) => step.run?.startsWith('npm ci'))).toBe(false)
    expect(prepare.steps.some((step) => step.run?.includes('cli.mts prepare'))).toBe(true)
    expect(prepare.steps.some((step) => step.id === 'app-token')).toBe(false)
    expect(JSON.stringify(prepare)).not.toContain('HVIR_GITHUB_TOKEN')

    const token = publish.steps.find((step) => step.id === 'app-token')
    expect(token?.uses).toBe(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    )
    expect(token?.with).toEqual({
      'client-id': '${{ vars.HVIR_GHOSTTY_WEB_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.HVIR_GHOSTTY_WEB_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    })
    const publishCheckout = publish.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )
    expect(publishCheckout?.with).toMatchObject({
      ref: '${{ github.sha }}',
      token: '${{ steps.app-token.outputs.token }}',
    })
    expect(publish.steps.some((step) => step.run?.includes('cli.mts publish'))).toBe(true)
    expect(JSON.stringify(publish)).not.toContain('npm ci')
  })

  it('pins artifact transfer actions and never interpolates expressions into shell source', () => {
    expect(workflow.jobs.prepare.steps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      }),
    )
    expect(workflow.jobs.publish.steps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      }),
    )
    expect(source).toContain('if [ "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH" ]')
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) expect(step.run ?? '').not.toContain('${{')
    }
  })

  it('sends the App-authored main pull request through every ordinary repository gate', () => {
    const ci = parse(ciSource) as {
      readonly jobs: Record<string, unknown>
      readonly on: { readonly pull_request: unknown }
    }
    expect(ci.on).toHaveProperty('pull_request')
    expect(Object.keys(ci.jobs)).toEqual(
      expect.arrayContaining([
        'verify',
        'electron-smoke',
        'macos-electron-smoke',
        'codeql',
        'merge-acceptance',
      ]),
    )
    expect(codeqlSource).not.toMatch(/^ {2}pull_request:/m)
    expect(planningSource).toMatch(/^\s+pull_request_target:/m)
    expect(source).not.toMatch(/(?:merge|auto-merge|workflow_dispatch).*pull request/i)
    expect(dependabotSource).toContain("dependency-name: 'ghostty-web'")
  })
})
