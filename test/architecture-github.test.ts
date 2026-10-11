import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  githubAdapter,
  loadArchitectureIntegration,
  requireCurrentRemovalIssues,
  resolveArchitectureContext,
} from '../scripts/architecture-github.mts'
import { REQUIRED_CI_JOBS } from '../scripts/ci-attempt-evidence.mts'
import { budget, ordinaryPolicy, repository } from './fixtures/architecture/repository.ts'

const fixtures: ReturnType<typeof repository>[] = []
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
const ref = (name: string, sha: string) => ({
  ref: name,
  sha,
  repo: { full_name: canonical },
})
function mockRequests(responses: Map<string, unknown>) {
  if (!responses.has('issues/733')) responses.set('issues/733', parent)
  if (!responses.has('issues/733/parent')) responses.set('issues/733/parent', null)
  if (!responses.has('issues/999'))
    responses.set('issues/999', { ...parent, number: 999 })
  if (!responses.has('issues/999/parent')) responses.set('issues/999/parent', null)
  const requests: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      const key = String(url).replace(apiRoot, '')
      requests.push(key)
      if (!responses.has(key)) throw new Error(`Unexpected fixture request: ${key}`)
      const value = responses.get(key)
      return Promise.resolve({
        ok: value !== null,
        status: value === null ? 404 : 200,
        json: () => Promise.resolve(value),
      })
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
      new Map<string, unknown>([
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
      new Map<string, unknown>([
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
    const responses = new Map<string, unknown>([
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
    mockRequests(new Map<string, unknown>([['issues/435', { state: 'closed' }]]))
    await expect(
      requireCurrentRemovalIssues(githubAdapter('fixture'), policy),
    ).rejects.toThrow(/completed or invalid/)
  })
  it.each([
    'valid',
    'partial-attempt',
    'wrong-parent',
    'wrong-tree',
    'wrong-base',
    'recovered',
    'unassociated-recovery',
    'deleted-fork-list-recovery',
    'paginated-list-recovery',
    'ambiguous-list-recovery',
    'incomplete-list-recovery',
    'incomplete-candidate-list-recovery',
    'indeterminate-list-recovery',
    'unterminated-list-recovery',
    'contradictory-list-recovery',
    'open-recovery',
    'ambiguous-recovery',
    'accepted-metadata',
    'policy-recovery',
    'checker-recovery',
    'wiring-recovery',
    'decision-recovery',
    'unreachable-recovery',
    'failed-recovery',
    'wrong-epic-recovery',
    'wrong-base-recovery',
    'wrong-tree-recovery',
    'wrong-head-recovery',
    'missing-ci-recovery',
    'missing-pr-recovery',
    'wrong-child-recovery',
    'wrong-repository-recovery',
    'renamed-policy-recovery',
  ])('loads exact accepted epic PR and coherent CI: %s', async (defect) => {
    const r = repo(),
      base = r.initial
    r.git('switch', '-c', 'epic/733-fixture')
    r.git('switch', '-c', 'policy-child')
    const recovery =
      defect !== 'valid' &&
      defect !== 'partial-attempt' &&
      defect !== 'wrong-parent' &&
      defect !== 'wrong-tree' &&
      defect !== 'wrong-base'
    r.write(
      defect === 'policy-recovery'
        ? 'scripts/architecture-hotspots.json'
        : defect === 'checker-recovery'
          ? 'scripts/architecture-github.mts'
          : defect === 'wiring-recovery'
            ? 'package.json'
            : defect === 'decision-recovery'
              ? 'docs/adr/ADR-099-fixture.md'
              : recovery
                ? 'src/fixture.ts'
                : 'docs/architecture-budgets.md',
      'fixture',
    )
    if (defect === 'renamed-policy-recovery')
      r.git('mv', 'scripts/architecture-hotspots.json', 'src/renamed-policy.json')
    const head = r.commit()
    const merge = r.integrate('policy-child', base)
    const tree = r.git('rev-parse', `${head}^{tree}`)
    const pr = {
      number: 20,
      state: defect === 'open-recovery' ? 'open' : 'closed',
      merged_at:
        recovery && defect !== 'accepted-metadata' ? null : '2026-09-05T00:00:00Z',
      merge_commit_sha: recovery ? base : merge,
      body:
        defect === 'wrong-child-recovery'
          ? 'Completes-child: #999'
          : 'Completes-child: #409',
      base: ref(
        epic,
        defect === 'wrong-base' || defect === 'wrong-base-recovery' ? head : base,
      ),
      head:
        defect === 'wrong-repository-recovery'
          ? { ...ref('policy-child', head), repo: { full_name: 'other/hvir' } }
          : ref('policy-child', head),
    }
    const listDiscovery =
      defect.includes('-list-recovery') || defect === 'unassociated-recovery'
    const closedList = `pulls?state=closed&base=${encodeURIComponent(epic)}&per_page=100&page=`
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
    if (defect === 'failed-recovery') jobs[1]!.conclusion = 'failure'
    const responses = new Map<string, unknown>([
      [
        `commits/${merge}/pulls?per_page=100&page=1`,
        defect === 'missing-pr-recovery' || listDiscovery ? [] : [pr],
      ],
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
              head_sha: defect === 'missing-ci-recovery' ? base : head,
              run_attempt: 2,
              run_number: 1,
              pull_requests: [],
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      ],
      ['actions/runs/42/attempts/2/jobs?per_page=100&page=1', { jobs }],
      [
        `compare/${merge}...${encodeURIComponent(epic)}`,
        {
          status: defect === 'unreachable-recovery' ? 'diverged' : 'identical',
          merge_base_commit: { sha: merge },
        },
      ],
      [
        `compare/${base}...${head}`,
        { status: 'ahead', merge_base_commit: { sha: base } },
      ],
      [
        `compare/${head}...${head}`,
        { status: 'identical', merge_base_commit: { sha: head } },
      ],
      [
        `git/commits/${merge}`,
        {
          sha: merge,
          tree: {
            sha:
              defect === 'wrong-tree' || defect === 'wrong-tree-recovery' ? base : tree,
          },
          parents: [
            { sha: base },
            { sha: defect === 'wrong-head-recovery' ? base : head },
          ],
        },
      ],
      [
        `git/commits/${head}`,
        { sha: head, tree: { sha: tree }, parents: [{ sha: base }] },
      ],
      ['pulls/20', pr],
      ['issues/409', { state: 'closed' }],
      ['issues/999', { ...parent, number: 999 }],
      ['issues/999/parent', null],
      [
        'issues/409/parent',
        defect === 'wrong-parent' || defect === 'wrong-epic-recovery' ? null : parent,
      ],
      ['git/matching-refs/heads/epic/733-', [{ ref: `refs/heads/${epic}` }]],
    ])
    if (recovery) {
      responses.set(
        `commits/${head}/pulls?per_page=100&page=1`,
        defect === 'ambiguous-recovery'
          ? [pr, { ...pr, number: 21 }]
          : defect === 'missing-pr-recovery' || listDiscovery
            ? []
            : [pr],
      )
      responses.set(`git/ref/heads/${epic}`, { object: { sha: merge } })
      if (defect === 'missing-pr-recovery') responses.set(`${closedList}1`, [])
      if (listDiscovery) {
        const unrelated = { ...pr, number: 19, head: ref('other-child', base) }
        responses.set(`${closedList}1`, [unrelated, pr])
        if (defect === 'deleted-fork-list-recovery')
          responses.set(`${closedList}1`, [
            { ...unrelated, head: { ...unrelated.head, repo: null } },
            pr,
          ])
        if (defect === 'ambiguous-list-recovery')
          responses.set(`${closedList}1`, [pr, { ...pr, number: 21 }])
        if (defect === 'incomplete-list-recovery')
          responses.set(`${closedList}1`, [{ ...pr, head: undefined }])
        if (defect === 'incomplete-candidate-list-recovery')
          responses.set(`${closedList}1`, [{ ...pr, head: { ...pr.head, repo: null } }])
        if (defect === 'indeterminate-list-recovery')
          responses.set(`${closedList}1`, [
            { ...pr, head: { ...pr.head, sha: undefined } },
          ])
        if (defect === 'contradictory-list-recovery')
          responses.set('pulls/20', { ...pr, base: ref(epic, head) })
        const fullPage = Array.from({ length: 100 }, (_, index) => ({
          ...unrelated,
          number: index + 100,
        }))
        if (defect === 'paginated-list-recovery') {
          responses.set(`${closedList}1`, fullPage)
          responses.set(`${closedList}2`, [pr])
        }
        if (defect === 'unterminated-list-recovery')
          for (let page = 1; page <= 10; page += 1)
            responses.set(`${closedList}${page}`, [pr, ...fullPage.slice(1)])
      }
    }
    const requests = mockRequests(responses)
    const result = loadArchitectureIntegration(
      r.root,
      githubAdapter('fixture'),
      merge,
      epic,
    )
    if (
      [
        'valid',
        'recovered',
        'unassociated-recovery',
        'paginated-list-recovery',
        'deleted-fork-list-recovery',
      ].includes(defect)
    ) {
      expect(await result).toEqual({ epic, pullRequest: 20, base, head, merge })
      expect(requests).toContain('actions/runs/42/attempts/2/jobs?per_page=100&page=1')
      if (listDiscovery) expect(requests).toContain(`${closedList}1`)
      if (defect === 'paginated-list-recovery')
        expect(requests).toContain(`${closedList}2`)
    } else {
      await expect(result).rejects.toThrow()
      // A missing fake response must not masquerade as rejection of the named defect.
      await expect(result).rejects.not.toThrow(
        /API unavailable|request failed|Unexpected fixture/,
      )
      if (
        defect === 'incomplete-list-recovery' ||
        defect === 'incomplete-candidate-list-recovery' ||
        defect === 'indeterminate-list-recovery'
      )
        await expect(result).rejects.toThrow(
          `Epic recovery merge=${merge} base=${base} head=${head}: GitHub merge evidence response was incomplete`,
        )
      if (defect === 'unterminated-list-recovery') {
        expect(requests.filter((path) => path.startsWith('pulls?'))).toHaveLength(10)
        expect(requests).not.toContain('pulls/20')
      }
    }
  })
})
