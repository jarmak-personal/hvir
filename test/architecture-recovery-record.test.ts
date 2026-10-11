import { afterEach, expect, it, vi } from 'vitest'
import record from './fixtures/architecture/pr-938.json'
import {
  githubAdapter,
  loadArchitectureIntegration,
} from '../scripts/architecture-github.mts'
import {
  evaluateReleaseCiEvidence,
  loadReleaseCiEvidence,
} from '../scripts/require-release-ci-evidence.mts'

// The exact captured #938 adapter record complements the real temporary Git
// topology tests. Here only the immediate Git and GitHub boundaries are faked.
vi.mock('../scripts/architecture-inventory.mts', async (original) => {
  const actual = await original<typeof import('../scripts/architecture-inventory.mts')>()
  return {
    ...actual,
    git: (_root: string, args: string[]) => {
      if (args[0] === 'diff') return record.changedPaths.join('\0')
      const commit = record.commits.find((commit) =>
        args.some((arg) => arg.startsWith(commit.sha)),
      )
      if (!commit) throw new Error('Unexpected Git fixture identity')
      if (args[0] === 'show') return commit.parents.map((parent) => parent.sha).join(' ')
      if (args[0] === 'rev-parse') return commit.tree.sha
      throw new Error('Unexpected Git fixture read')
    },
    requireAncestor: (_root: string, base: string, head: string) => {
      if (base === record.pullRequest.base.sha && head === record.pullRequest.head.sha)
        return
      if (base === record.commits[0]!.sha && head === base) return
      throw new Error('Unproven fixture ancestry')
    },
  }
})

afterEach(() => vi.unstubAllGlobals())

it('recovers the captured Closed #938 history without manufacturing release acceptance', async () => {
  const pr = record.pullRequest
  const merge = record.commits[0]!.sha
  const root = 'https://api.github.com/repos/jarmak-personal/hvir/'
  const parent = {
    number: 848,
    state: 'open',
    repository_url: root.slice(0, -1),
    labels: [{ name: 'kind:epic' }],
  }
  const responses = new Map<string, unknown>([
    [`commits/${merge}/pulls?per_page=100&page=1`, []],
    [`commits/${pr.head.sha}/pulls?per_page=100&page=1`, [pr]],
    ['pulls/938', pr],
    [
      `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100&page=1`,
      { workflow_runs: [record.run] },
    ],
    [
      `actions/runs/${record.run.id}/attempts/1/jobs?per_page=100&page=1`,
      { jobs: record.jobs },
    ],
    [`git/commits/${merge}`, record.commits[0]],
    [`git/commits/${pr.head.sha}`, record.commits[1]],
    [`compare/${pr.base.sha}...${pr.head.sha}`, record.baseComparison],
    [
      `compare/${merge}...${encodeURIComponent(pr.base.ref)}`,
      { status: 'identical', merge_base_commit: { sha: merge } },
    ],
    ['issues/859', { number: 859, state: 'closed' }],
    ['issues/859/parent', parent],
    ['issues/848', parent],
    ['issues/848/parent', null],
    ['git/matching-refs/heads/epic/848-', [{ ref: `refs/heads/${pr.base.ref}` }]],
    [`git/ref/heads/${pr.base.ref}`, { object: { sha: merge } }],
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string) => {
      const key = String(input).replace(root, '')
      if (!responses.has(key)) throw new Error(`Unexpected fixture read ${key}`)
      const value = responses.get(key)
      return Promise.resolve({
        ok: value !== null,
        status: value === null ? 404 : 200,
        json: () => Promise.resolve(value),
      })
    }),
  )
  expect(record.run.pull_requests).toEqual([])
  expect(pr.merged_at).toBeNull()
  expect(pr.merge_commit_sha).not.toBe(merge)
  await expect(
    loadArchitectureIntegration(
      'captured-record',
      githubAdapter('fixture'),
      merge,
      pr.base.ref,
    ),
  ).resolves.toEqual({
    epic: pr.base.ref,
    pullRequest: 938,
    base: pr.base.sha,
    head: pr.head.sha,
    merge,
  })
  // The release reader does not search the head for a recovered PR.
  responses.set(`commits/${merge}/pulls?per_page=100&page=1`, [pr])
  const release = await loadReleaseCiEvidence(
    'jarmak-personal/hvir',
    pr.base.ref,
    merge,
    'fixture',
  )
  expect(evaluateReleaseCiEvidence(release)).toEqual({
    accepted: false,
    rejection: 'missing-pull-request',
  })
})
