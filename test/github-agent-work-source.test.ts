import { describe, expect, it, vi } from 'vitest'

import { GitHubAgentWorkSource } from '../scripts/project-management/github-agent-work-source.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'

interface GraphqlRequest {
  query: string
  variables: Record<string, unknown>
}

describe('GitHub agent-work projection source', () => {
  it('reads body, kind labels, and parent in one purpose-shaped query plus label pages', async () => {
    const requests: GraphqlRequest[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init)
        requests.push(request)
        if (request.query.includes('AgentWorkProjectionIssue')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  body: 'private issue prose',
                  labels: connection([{ name: 'area:docs' }], 'labels-next'),
                  parent: {
                    number: 570,
                    repository: { nameWithOwner: 'jarmak-personal/hvir' },
                  },
                },
              },
            }),
          )
        }
        if (request.query.includes('AgentWorkIssueLabels')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  labels: connection([{ name: 'kind:feature' }]),
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${request.query}`)
      },
    )

    await expect(source(fetchImplementation).readProjectionIssue(574)).resolves.toEqual({
      body: 'private issue prose',
      kind: 'other',
      parent: { number: 570, repository: 'jarmak-personal/hvir' },
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.variables).toEqual({
      owner: 'jarmak-personal',
      name: 'hvir',
      number: 574,
    })
    expect(requests[1]?.variables).toEqual({
      owner: 'jarmak-personal',
      name: 'hvir',
      number: 574,
      after: 'labels-next',
    })
    expect(requests[0]?.query).not.toMatch(/\b(?:state|subIssues|comments|title|id)\b/)
    expect(requests[1]?.query).not.toMatch(/\b(?:body|parent|state|subIssues)\b/)
  })

  it('reports a fixed missing-issue diagnostic without response content', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ repository: { issue: null } })),
    )

    await expect(source(fetchImplementation).readProjectionIssue(574)).rejects.toThrow(
      'Issue #574 was not found in the configured repository jarmak-personal/hvir',
    )
  })
})

describe('GitHub agent-work Rollup source', () => {
  it('reads a root once and paginates only labels and direct children that continue', async () => {
    const requests: GraphqlRequest[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init)
        requests.push(request)
        if (request.query.includes('AgentWorkRollupTarget')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  number: 570,
                  state: 'OPEN',
                  labels: connection([{ name: 'area:docs' }], 'labels-next'),
                  parent: null,
                  subIssues: connection(
                    [issueReference(572, 'jarmak-personal/hvir')],
                    'children-next',
                  ),
                },
              },
            }),
          )
        }
        if (request.query.includes('AgentWorkIssueLabels')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: { labels: connection([{ name: 'kind:epic' }]) },
              },
            }),
          )
        }
        if (request.query.includes('AgentWorkRollupChildren')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  subIssues: connection([issueReference(571, 'jarmak-personal/hvir')]),
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${request.query}`)
      },
    )

    await expect(source(fetchImplementation).readRollupTarget(570)).resolves.toEqual({
      number: 570,
      repository: 'jarmak-personal/hvir',
      state: 'OPEN',
      kind: 'epic',
      parent: null,
      hasDirectChildren: true,
      directChildren: [
        { number: 571, repository: 'jarmak-personal/hvir' },
        { number: 572, repository: 'jarmak-personal/hvir' },
      ],
    })
    expect(requests).toHaveLength(3)
    expect(requests.map(({ query }) => query)).toEqual([
      expect.stringContaining('AgentWorkRollupTarget'),
      expect.stringContaining('AgentWorkIssueLabels'),
      expect.stringContaining('AgentWorkRollupChildren'),
    ])
    expect(requests[1]?.query).not.toMatch(/\b(?:parent|state|subIssues)\b/)
    expect(requests[2]?.query).not.toMatch(/\b(?:labels|parent|state)\b/)
    expect(
      requests.every(
        ({ query }) => !/\b(?:body|comments|title|updatedAt|id)\b/.test(query),
      ),
    ).toBe(true)
  })

  it('reads each participant relationship, kind, state, and descendant presence once', async () => {
    const requests: GraphqlRequest[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init)
        requests.push(request)
        return Promise.resolve(
          graphqlData({
            repository: {
              issue: {
                number: 571,
                state: 'CLOSED',
                labels: connection([{ name: 'kind:feature' }]),
                parent: {
                  number: 570,
                  repository: { nameWithOwner: 'jarmak-personal/hvir' },
                },
                subIssues: { totalCount: 1 },
              },
            },
          }),
        )
      },
    )

    await expect(source(fetchImplementation).readRollupParticipant(571)).resolves.toEqual(
      {
        number: 571,
        repository: 'jarmak-personal/hvir',
        state: 'CLOSED',
        kind: 'other',
        parent: { number: 570, repository: 'jarmak-personal/hvir' },
        hasDirectChildren: true,
      },
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toContain('AgentWorkRollupParticipant')
    expect(requests[0]?.query).toContain('subIssues(first: 1) { totalCount }')
    expect(requests[0]?.query).not.toMatch(/\b(?:body|comments|title|updatedAt|id)\b/)
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

function requestBody(init: RequestInit | undefined): GraphqlRequest {
  if (typeof init?.body !== 'string') throw new Error('Expected GraphQL body.')
  return JSON.parse(init.body) as GraphqlRequest
}

function connection<T>(nodes: T[], nextCursor?: string) {
  return {
    nodes,
    pageInfo: {
      endCursor: nextCursor ?? null,
      hasNextPage: nextCursor !== undefined,
    },
  }
}

function issueReference(number: number, repository: string) {
  return { number, repository: { nameWithOwner: repository } }
}

function graphqlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
