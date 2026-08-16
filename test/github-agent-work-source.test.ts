import { describe, expect, it, vi } from 'vitest'

import { GitHubAgentWorkSource } from '../scripts/project-management/github-agent-work-source.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'

describe('GitHub agent-work projection source', () => {
  it('returns the issue body only inside the projection boundary', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected GraphQL body.')
        const request = JSON.parse(init.body) as {
          query: string
          variables: Record<string, unknown>
        }
        expect(request.query).toContain('IssueAgentWorkForecast')
        expect(request.variables).toEqual({
          owner: 'jarmak-personal',
          name: 'hvir',
          number: 574,
        })
        return Promise.resolve(
          graphqlData({ repository: { issue: { body: 'private issue prose' } } }),
        )
      },
    )

    await expect(source(fetchImplementation).readIssueBody(574)).resolves.toBe(
      'private issue prose',
    )
  })

  it('reports a fixed missing-issue diagnostic without a response body', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ repository: { issue: null } })),
    )

    await expect(source(fetchImplementation).readIssueBody(574)).rejects.toThrow(
      'Issue #574 was not found in the configured repository jarmak-personal/hvir',
    )
  })

  it('paginates content-free native issue structure for direct-child Rollups', async () => {
    const queries: string[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected GraphQL body.')
        const request = JSON.parse(init.body) as {
          query: string
          variables: Record<string, unknown>
        }
        queries.push(request.query)
        const second = request.variables.after !== null
        if (request.query.includes('IssueKind')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  id: 'issue-id',
                  number: 570,
                  state: 'OPEN',
                  updatedAt: '2026-08-16T12:00:00Z',
                  labels: {
                    nodes: [{ name: second ? 'kind:epic' : 'area:docs' }],
                    pageInfo: {
                      endCursor: second ? null : 'labels-next',
                      hasNextPage: !second,
                    },
                  },
                },
              },
            }),
          )
        }
        if (request.query.includes('IssueParent')) {
          return Promise.resolve(graphqlData({ repository: { issue: { parent: null } } }))
        }
        if (request.query.includes('IssueSubIssues')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  subIssues: {
                    nodes: [
                      {
                        number: second ? 572 : 571,
                        state: second ? 'CLOSED' : 'OPEN',
                        repository: { nameWithOwner: 'jarmak-personal/hvir' },
                      },
                    ],
                    pageInfo: {
                      endCursor: second ? null : 'children-next',
                      hasNextPage: !second,
                    },
                  },
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${request.query}`)
      },
    )

    await expect(source(fetchImplementation).readRollupIssue(570)).resolves.toEqual({
      number: 570,
      repository: 'jarmak-personal/hvir',
      state: 'OPEN',
      kind: 'epic',
      parent: null,
      directChildren: [
        { number: 571, repository: 'jarmak-personal/hvir' },
        { number: 572, repository: 'jarmak-personal/hvir' },
      ],
    })
    expect(queries.every((query) => !/\b(title|body|comments)\b/.test(query))).toBe(true)
    expect(queries.every((query) => !query.includes('IssuePullRequests'))).toBe(true)
  })
})

function source(fetchImplementation: typeof fetch): GitHubAgentWorkSource {
  return new GitHubAgentWorkSource({
    owner: 'jarmak-personal',
    name: 'hvir',
    client: new GitHubClient({
      token: 'repo-token',
      purpose: 'test',
      fetchImplementation,
      wait: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

function graphqlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
