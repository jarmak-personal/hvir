import { describe, expect, it, vi } from 'vitest'

import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { GitHubPullRequestRepository } from '../scripts/project-management/github-pull-requests.ts'

function graphqlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(init: RequestInit | undefined): {
  query: string
  variables: Record<string, unknown>
} {
  if (typeof init?.body !== 'string') throw new Error('Expected a GraphQL body.')
  return JSON.parse(init.body) as {
    query: string
    variables: Record<string, unknown>
  }
}

function repository(fetchImplementation: typeof fetch): GitHubPullRequestRepository {
  return new GitHubPullRequestRepository({
    owner: 'jarmak-personal',
    name: 'hvir',
    client: new GitHubClient({
      token: 'repo-token',
      purpose: 'test repository',
      fetchImplementation,
      wait: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

describe('GitHub pull request planning adapter', () => {
  it('paginates native completion relationships and excludes manually linked issues', async () => {
    const queries: string[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = requestBody(init)
        queries.push(request.query)
        if (request.query.includes('PullRequestPlanning')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                pullRequest: {
                  number: 86,
                  state: 'OPEN',
                  isDraft: true,
                  mergedAt: null,
                  body: 'Contributes-to: #50',
                  repository: { nameWithOwner: 'jarmak-personal/hvir' },
                },
              },
            }),
          )
        }
        if (request.query.includes('PullRequestClosingIssues')) {
          const manuallyLinked = request.variables.userLinkedOnly === true
          const second = request.variables.after === 'next-issue'
          return Promise.resolve(
            graphqlData({
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: manuallyLinked
                      ? [issueNode(51)]
                      : [issueNode(second ? 51 : 50)],
                    pageInfo: {
                      endCursor: manuallyLinked || second ? null : 'next-issue',
                      hasNextPage: !manuallyLinked && !second,
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

    await expect(repository(fetchImplementation).getPullRequest(86)).resolves.toEqual({
      repository: 'jarmak-personal/hvir',
      number: 86,
      state: 'OPEN',
      isDraft: true,
      mergedAt: null,
      body: 'Contributes-to: #50',
      closingIssues: [
        {
          repository: 'jarmak-personal/hvir',
          number: 50,
          state: 'OPEN',
        },
      ],
    })
    expect(queries.every((query) => !/\b(title|comments|headRef)\b/.test(query))).toBe(
      true,
    )
  })

  it('paginates only open PR bodies for contribution recomputation', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = requestBody(init)
        expect(request.query).toContain('states: OPEN')
        const second = request.variables.after === 'next-pr'
        return Promise.resolve(
          graphqlData({
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: second ? 90 : 89,
                    body: `Contributes-to: #${second ? 50 : 86}`,
                    repository: { nameWithOwner: 'jarmak-personal/hvir' },
                  },
                ],
                pageInfo: {
                  endCursor: second ? null : 'next-pr',
                  hasNextPage: !second,
                },
              },
            },
          }),
        )
      },
    )

    await expect(
      repository(fetchImplementation).listOpenPullRequestBodies(),
    ).resolves.toEqual([
      {
        repository: 'jarmak-personal/hvir',
        number: 89,
        body: 'Contributes-to: #86',
      },
      {
        repository: 'jarmak-personal/hvir',
        number: 90,
        body: 'Contributes-to: #50',
      },
    ])
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('fails by configured identity when the PR is missing or inaccessible', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ repository: { pullRequest: null } })),
    )

    await expect(repository(fetchImplementation).getPullRequest(86)).rejects.toThrow(
      'jarmak-personal/hvir',
    )
  })
})

function issueNode(number: number): object {
  return {
    number,
    state: 'OPEN',
    repository: { nameWithOwner: 'jarmak-personal/hvir' },
  }
}
