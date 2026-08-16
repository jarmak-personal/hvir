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
