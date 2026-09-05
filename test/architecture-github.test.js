import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  githubAdapter,
  loadArchitectureIntegration,
  requireCurrentRemovalIssues,
  resolveArchitectureContext,
} from '../scripts/architecture-github.mjs'
import { REQUIRED_CI_JOBS } from '../scripts/ci-attempt-evidence.mts'
import {
  budget,
  ordinaryPolicy,
  repository,
} from './fixtures/architecture/repository.mjs'

const fixtures = []
function repo() {
  const r = repository()
  fixtures.push(r)
  r.git('remote', 'add', 'origin', 'https://github.com/jarmak-personal/hvir.git')
  return r
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const r of fixtures.splice(0)) r.dispose()
})
const canonical = 'jarmak-personal/hvir'
const apiRoot = `https://api.github.com/repos/${canonical}/`
const epic = 'epic/733-fixture'
const parent = {
  number: 733,
  state: 'open',
  repository_url: apiRoot.slice(0, -1),
  labels: [{ name: 'kind:epic' }],
}
const ref = (name, sha) => ({ ref: name, sha, repo: { full_name: canonical } })
function mockRequests(responses) {
  if (!responses.has('issues/733')) responses.set('issues/733', parent)
  if (!responses.has('issues/733/parent')) responses.set('issues/733/parent', null)
  if (!responses.has('issues/999'))
    responses.set('issues/999', { ...parent, number: 999 })
  if (!responses.has('issues/999/parent')) responses.set('issues/999/parent', null)
  const requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const key = String(url).replace(apiRoot, '')
      requests.push(key)
      if (!responses.has(key)) throw new Error(`Unexpected fixture request: ${key}`)
      const value = responses.get(key)
      return {
        ok: value !== null,
        status: value === null ? 404 : 200,
        json: async () => value,
      }
    }),
  )
  return requests
}

describe('architecture GitHub evidence boundary', () => {
  it('fails enforcement without repository evidence credentials', () => {
    expect(() => githubAdapter('')).toThrow(/HVIR_REPO_TOKEN/)
  })
  it('resolves local delivery from the actual native parent and live epic ref', async () => {
    const r = repo()
    r.git('switch', '-c', 'agent/issue-409')
    mockRequests(
      new Map([
        ['issues/409', { number: 409, state: 'open' }],
        ['issues/409/parent', parent],
        ['git/matching-refs/heads/epic/733-', [{ ref: `refs/heads/${epic}` }]],
        [`git/ref/heads/${epic}`, { object: { sha: r.initial } }],
      ]),
    )
    expect(
      await resolveArchitectureContext(r.root, githubAdapter('fixture'), {}),
    ).toMatchObject({
      kind: 'epic-child',
      epic,
      target: epic,
      base: r.initial,
      head: r.initial,
    })
  })
  it('resolves ordinary local delivery when native parent is absent', async () => {
    const r = repo()
    r.git('switch', '-c', 'agent/issue-409')
    mockRequests(
      new Map([
        ['issues/409', { state: 'open' }],
        ['issues/409/parent', null],
        ['git/ref/heads/main', { object: { sha: r.initial } }],
      ]),
    )
    expect(
      await resolveArchitectureContext(r.root, githubAdapter('fixture'), {}),
    ).toMatchObject({ kind: 'ordinary', target: 'main' })
  })
  it.each([
    'valid',
    'changed-tree',
    'changed-head',
    'changed-base',
    'wrong-epic',
    'closed-epic',
    'nested-epic',
    'ambiguous-epic',
    'moving-target',
  ])('qualifies CI merge-ref identities: %s', async (defect) => {
    const r = repo(),
      base = r.initial
    r.git('switch', '-c', 'agent/issue-409')
    r.source(1)
    const head = r.commit()
    r.git('switch', 'main')
    r.git('merge', '--no-ff', 'agent/issue-409', '-m', 'fixture merge')
    let tested = r.git('rev-parse', 'HEAD')
    if (defect === 'changed-tree') {
      r.source(2)
      tested = r.commit()
    }
    const pr = {
      number: 20,
      body: 'Completes-child: #409',
      head: ref('agent/issue-409', head),
      base: ref(epic, base),
    }
    const event = { number: 20, pull_request: globalThis.structuredClone(pr) }
    if (defect === 'changed-head') pr.head.sha = base
    if (defect === 'changed-base') pr.base.sha = head
    const responses = new Map([
      ['pulls/20', pr],
      ['issues/409', { state: 'open' }],
      [
        'issues/409/parent',
        defect === 'wrong-epic' ? { ...parent, number: 999 } : parent,
      ],
      ['git/matching-refs/heads/epic/733-', [{ ref: `refs/heads/${epic}` }]],
      ['git/matching-refs/heads/epic/999-', [{ ref: 'refs/heads/epic/999-other' }]],
      [`git/ref/heads/${epic}`, { object: { sha: base } }],
    ])
    if (defect === 'closed-epic')
      responses.set('issues/733', { ...parent, state: 'closed' })
    if (defect === 'nested-epic')
      responses.set('issues/733/parent', { ...parent, number: 999 })
    if (defect === 'ambiguous-epic')
      responses.set('git/matching-refs/heads/epic/733-', [
        { ref: `refs/heads/${epic}` },
        { ref: 'refs/heads/epic/733-other' },
      ])
    if (defect === 'moving-target')
      responses.set(`git/ref/heads/${epic}`, { object: { sha: head } })
    mockRequests(responses)
    r.write('event.json', JSON.stringify(event))
    const result = resolveArchitectureContext(r.root, githubAdapter('fixture'), {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: canonical,
      GITHUB_SHA: tested,
      GITHUB_EVENT_PATH: join(r.root, 'event.json'),
    })
    if (defect === 'valid')
      expect(await result).toMatchObject({ base, head, tested, kind: 'epic-child' })
    else await expect(result).rejects.toThrow()
  })
  it('rejects a completed removal issue instead of retaining stale transitional metadata', async () => {
    const policy = ordinaryPolicy()
    policy.budgets.push(budget())
    mockRequests(new Map([['issues/435', { state: 'closed' }]]))
    await expect(
      requireCurrentRemovalIssues(githubAdapter('fixture'), policy),
    ).rejects.toThrow(/completed or invalid/)
  })
  it.each(['valid', 'partial-attempt', 'wrong-parent', 'wrong-tree', 'wrong-base'])(
    'loads exact accepted epic PR and coherent CI: %s',
    async (defect) => {
      const r = repo(),
        base = r.initial
      r.git('switch', '-c', 'epic/733-fixture')
      r.git('switch', '-c', 'policy-child')
      r.write('docs/architecture-budgets.md', 'fixture')
      const head = r.commit()
      const merge = r.integrate('policy-child', base)
      const tree = r.git('rev-parse', `${head}^{tree}`)
      const pr = {
        number: 20,
        state: 'closed',
        merged_at: '2026-09-05T00:00:00Z',
        merge_commit_sha: merge,
        body: 'Completes-child: #409',
        base: ref(epic, defect === 'wrong-base' ? head : base),
        head: ref('policy-child', head),
      }
      const jobs = [
        { name: 'Release version integrity', status: 'completed', conclusion: 'skipped' },
        ...REQUIRED_CI_JOBS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
        { name: 'Merge acceptance', status: 'completed', conclusion: 'success' },
      ]
      if (defect === 'partial-attempt') jobs.splice(1, 1)
      const responses = new Map([
        [`commits/${merge}/pulls?per_page=100&page=1`, [pr]],
        [
          `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100&page=1`,
          {
            workflow_runs: [
              {
                id: 42,
                name: 'CI',
                path: '.github/workflows/ci.yml',
                repository: { full_name: canonical },
                head_repository: { full_name: canonical },
                event: 'pull_request',
                head_branch: 'policy-child',
                head_sha: head,
                run_attempt: 2,
                status: 'completed',
                conclusion: 'success',
              },
            ],
          },
        ],
        ['actions/runs/42/attempts/2/jobs?per_page=100&page=1', { jobs }],
        [
          `compare/${merge}...${encodeURIComponent(epic)}`,
          { status: 'identical', merge_base_commit: { sha: merge } },
        ],
        [
          `compare/${base}...${head}`,
          { status: 'ahead', merge_base_commit: { sha: base } },
        ],
        [
          `git/commits/${merge}`,
          {
            sha: merge,
            tree: { sha: defect === 'wrong-tree' ? base : tree },
            parents: [{ sha: base }, { sha: head }],
          },
        ],
        [
          `git/commits/${head}`,
          { sha: head, tree: { sha: tree }, parents: [{ sha: base }] },
        ],
        ['pulls/20', pr],
        ['issues/409', { state: 'closed' }],
        ['issues/409/parent', defect === 'wrong-parent' ? null : parent],
        ['git/matching-refs/heads/epic/733-', [{ ref: `refs/heads/${epic}` }]],
      ])
      const requests = mockRequests(responses)
      const result = loadArchitectureIntegration(
        r.root,
        githubAdapter('fixture'),
        merge,
        epic,
      )
      if (defect === 'valid') {
        expect(await result).toEqual({ epic, pullRequest: 20, base, head, merge })
        expect(requests).toContain('actions/runs/42/attempts/2/jobs?per_page=100&page=1')
      } else await expect(result).rejects.toThrow()
    },
  )
})
