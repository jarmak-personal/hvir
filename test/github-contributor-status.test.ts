import { describe, expect, it, vi } from 'vitest'
import { readGitHubAcceptance } from '../scripts/project-management/github-contributor-acceptance.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { GitHubSessionTokens } from '../scripts/project-management/github-session-tokens.ts'
import { serializeTokenReceipt } from '../scripts/project-management/session-token-receipts.ts'
import { LEGACY_PROJECT_FIELDS } from '../scripts/project-management/canonical-project-config.ts'
import {
  planMeasurementRetirement,
  retireProjectMeasurements,
} from '../scripts/project-management/retire-project-measurements.ts'

const receipt = {
  schema: 2 as const,
  issue: 757,
  receipt: 'a'.repeat(64),
  provider: 'codex' as const,
  tokens: 100,
}
const pr = {
  number: 900,
  state: 'OPEN',
  baseRefName: 'main',
  headRefOid: 'a'.repeat(40),
  isDraft: false,
  autoMergeRequest: { enabledAt: 'now' },
  reviewDecision: 'APPROVED',
  mergeStateStatus: 'BLOCKED',
}
const response = (data: unknown) => new Response(JSON.stringify({ data }))
function request(init?: RequestInit): {
  query: string
  variables: Record<string, string | null>
} {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
  return JSON.parse(init.body) as {
    query: string
    variables: Record<string, string | null>
  }
}
const client = (fetchImplementation: typeof fetch) =>
  new GitHubClient({ token: 'private-token', purpose: 'test', fetchImplementation })

describe('immediate GitHub contributor adapters', () => {
  it('reads native required flags, paginates and detects candidate movement', async () => {
    let reads = 0
    const queries: string[] = []
    const github = client((_url, init) => {
      const { query, variables } = request(init)
      queries.push(query)
      if (query.includes('ContributorAcceptance'))
        return Promise.resolve(
          response({
            repository: {
              pullRequest: { ...pr, headRefOid: (++reads === 1 ? 'a' : 'b').repeat(40) },
            },
          }),
        )
      return Promise.resolve(
        response({
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: 'a'.repeat(40),
                      statusCheckRollup: {
                        contexts: {
                          nodes: variables.after
                            ? [
                                {
                                  __typename: 'StatusContext',
                                  context: 'required status',
                                  state: 'PENDING',
                                  isRequired: true,
                                },
                              ]
                            : [
                                {
                                  __typename: 'CheckRun',
                                  name: 'optional failure',
                                  status: 'COMPLETED',
                                  conclusion: 'FAILURE',
                                  isRequired: false,
                                },
                              ],
                          pageInfo: {
                            endCursor: variables.after ? null : 'next',
                            hasNextPage: !variables.after,
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      )
    })
    expect(await readGitHubAcceptance(github, 'owner', 'repo', 900)).toMatchObject({
      mergeRequest: true,
      stale: true,
      checksAvailable: true,
      checks: [{ name: 'required status', bucket: 'pending' }],
    })
    expect(
      queries.some((query) => query.includes('isRequired(pullRequestNumber:$number)')),
    ).toBe(true)
  })
  it('keeps missing check evidence unknown and independent native PR facts available', async () => {
    const github = client((_url, init) =>
      Promise.resolve(
        response({
          repository: {
            pullRequest: request(init).query.includes('ContributorAcceptance')
              ? pr
              : {
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: 'a'.repeat(40),
                          statusCheckRollup: null,
                        },
                      },
                    ],
                  },
                },
          },
        }),
      ),
    )
    expect(await readGitHubAcceptance(github, 'owner', 'repo', 900)).toMatchObject({
      state: 'OPEN',
      checksAvailable: false,
      checks: [],
    })
  })
  it('paginates receipt reads and excludes untrusted comments', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve().then(() => {
        const { variables } = request(init)
        return response({
          repository: {
            issue: {
              comments: {
                nodes: [
                  {
                    body: serializeTokenReceipt(receipt),
                    author: { login: variables.after ? 'outsider' : 'owner' },
                    createdAt: 'now',
                    updatedAt: 'now',
                  },
                ],
                pageInfo: {
                  hasNextPage: !variables.after,
                  endCursor: variables.after ? null : 'next',
                },
              },
            },
          },
        })
      }),
    )
    expect(
      (await new GitHubSessionTokens(client(fetcher), 'owner', 'repo').read(757))
        .receipts,
    ).toEqual([receipt])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not automatically replay an uncertain append transport', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network private body'))
    await expect(
      new GitHubSessionTokens(client(fetcher), 'owner', 'repo').append(receipt),
    ).rejects.toThrow('append uncertain')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('plans only exact legacy renames and preserves already transitioned fields', () => {
    const fields = LEGACY_PROJECT_FIELDS.map((field) => ({
      id: field.id!,
      name: field.name!,
    }))
    expect(planMeasurementRetirement(fields).diagnostics).toEqual([])
    expect(planMeasurementRetirement(fields).changes).toHaveLength(13)
    expect(
      planMeasurementRetirement(
        fields.map((row) => ({ ...row, name: `Legacy: ${row.name}` })),
      ).changes,
    ).toEqual([])
    expect(
      planMeasurementRetirement([
        ...fields,
        { id: 'other', name: `Legacy: ${fields[0]!.name}` },
      ]).diagnostics,
    ).not.toEqual([])
  })
  it('dry-runs without mutations and retries a partial field rename without touching values', async () => {
    const fields = LEGACY_PROJECT_FIELDS.map((field) => ({
      id: field.id!,
      name: field.name!,
    }))
    let fail = true
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve().then(() => {
        const { query, variables } = request(init)
        if (query.includes('query RetiredProjectFields'))
          return response({
            node: {
              fields: {
                nodes: fields,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        expect(query).not.toMatch(/delete|updateProjectV2ItemFieldValue/)
        if (fail && variables.id === fields[1]!.id) throw new Error('offline')
        if (typeof variables.name !== 'string') throw new Error('Missing name')
        fields.find((row) => row.id === variables.id)!.name = variables.name
        return response({ updateProjectV2Field: {} })
      }),
    )
    const github = client(fetcher)
    const plan = await retireProjectMeasurements(github, false)
    expect(plan.operations).toHaveLength(13)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // GitHubClient transport retries are tested by their own owner; avoid delays here.
    const first = await retireProjectMeasurements(github, true)
    expect(first.operations).toHaveLength(1)
    fail = false
    expect((await retireProjectMeasurements(github, true)).operations).toHaveLength(12)
  })
})
