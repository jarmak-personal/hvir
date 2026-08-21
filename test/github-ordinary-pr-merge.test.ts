import { describe, expect, it, vi } from 'vitest'

import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { GitHubOrdinaryPullRequestMerge } from '../scripts/project-management/github-ordinary-pr-merge.ts'

const candidate = 'a'.repeat(40)
const mergeCommit = 'b'.repeat(40)

function adapter(fetchImplementation: typeof fetch): GitHubOrdinaryPullRequestMerge {
  return new GitHubOrdinaryPullRequestMerge({
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

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('GitHub ordinary pull request merge adapter', () => {
  it('reads exact head, native relationship, mergeability, and only required checks', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(requestBody(init)) as {
          query: string
          variables: Record<string, unknown>
        }
        expect(body.query).toContain('isRequired(pullRequestNumber: $number)')
        expect(body.variables).toEqual({
          owner: 'jarmak-personal',
          name: 'hvir',
          number: 700,
        })
        return Promise.resolve(
          graphqlResponse({
            repository: {
              nameWithOwner: 'jarmak-personal/hvir',
              pullRequest: {
                number: 700,
                state: 'OPEN',
                isDraft: false,
                baseRefName: 'main',
                headRefName: 'agent/issue-611',
                headRefOid: candidate,
                headRepository: { nameWithOwner: 'jarmak-personal/hvir' },
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                reviewDecision: 'APPROVED',
                mergeCommit: null,
                closingIssuesReferences: {
                  nodes: [
                    {
                      number: 611,
                      repository: { nameWithOwner: 'jarmak-personal/hvir' },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: candidate,
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'Merge acceptance',
                                status: 'COMPLETED',
                                conclusion: 'SUCCESS',
                                isRequired: true,
                              },
                              {
                                __typename: 'CheckRun',
                                name: 'Informational',
                                status: 'COMPLETED',
                                conclusion: 'FAILURE',
                                isRequired: false,
                              },
                              {
                                __typename: 'StatusContext',
                                context: 'External policy',
                                state: 'PENDING',
                                isRequired: true,
                              },
                            ],
                            pageInfo: { hasNextPage: false },
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
      },
    )

    await expect(adapter(fetchImplementation).readPullRequest(700)).resolves.toEqual({
      repository: 'jarmak-personal/hvir',
      number: 700,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'agent/issue-611',
      headRefOid: candidate,
      headRepository: 'jarmak-personal/hvir',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      mergeCommitOid: null,
      closingIssues: [{ repository: 'jarmak-personal/hvir', number: 611 }],
      relationshipsComplete: true,
      requiredChecks: [
        { name: 'External policy', outcome: 'pending' },
        { name: 'Merge acceptance', outcome: 'success' },
      ],
      checksComplete: true,
    })
  })

  it('sends one normal merge request guarded by the exact candidate head', async () => {
    const fetchImplementation = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(requestUrl(url)).toMatch(
          /\/repos\/jarmak-personal\/hvir\/pulls\/700\/merge$/,
        )
        expect(init?.method).toBe('PUT')
        expect(JSON.parse(requestBody(init))).toEqual({
          sha: candidate,
          merge_method: 'merge',
        })
        return Promise.resolve(
          new Response(JSON.stringify({ merged: true, sha: mergeCommit }), {
            status: 200,
          }),
        )
      },
    )

    await expect(
      adapter(fetchImplementation).mergePullRequest(700, candidate),
    ).resolves.toEqual({ outcome: 'merged', mergeCommitOid: mergeCommit })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['branch protection rejection', new Response('{}', { status: 405 }), 'rejected'],
    ['ambiguous server failure', new Response('{}', { status: 503 }), 'uncertain'],
  ])('reports %s without retrying the mutation', async (_name, response, outcome) => {
    const fetchImplementation = vi.fn(() => Promise.resolve(response))

    await expect(
      adapter(fetchImplementation).mergePullRequest(700, candidate),
    ).resolves.toEqual({ outcome })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })
})

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body.')
  return init.body
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}
