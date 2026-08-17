import { describe, expect, it, vi } from 'vitest'

import {
  AgentWorkAppendRejectedError,
  AgentWorkAppendUncertainError,
} from '../scripts/project-management/agent-work-ledger.ts'
import { GitHubAgentWorkLedger } from '../scripts/project-management/github-agent-work-ledger.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function graphqlData(data: unknown): Response {
  return jsonResponse({ data })
}

function requestBody(init: RequestInit | undefined): {
  query: string
  variables: Record<string, unknown>
} {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
  return JSON.parse(init.body) as {
    query: string
    variables: Record<string, unknown>
  }
}

function ledger(fetchImplementation: typeof fetch): GitHubAgentWorkLedger {
  return new GitHubAgentWorkLedger({
    owner: 'jarmak-personal',
    name: 'hvir',
    client: new GitHubClient({
      token: 'repo-token',
      purpose: 'repository',
      fetchImplementation,
      wait: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

describe('GitHub agent-work ledger adapter', () => {
  it('paginates bounded comment provenance without requesting IDs or issue prose', async () => {
    const queries: string[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        queries.push(body.query)
        const second = body.variables.after === 'comments-next'
        return Promise.resolve(
          graphqlData({
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      body: second ? 'second body' : 'first body',
                      author: second ? null : { login: 'jarmak-personal' },
                      createdAt: '2026-08-17T12:00:00Z',
                      updatedAt: '2026-08-17T12:00:00Z',
                    },
                  ],
                  pageInfo: {
                    endCursor: second ? null : 'comments-next',
                    hasNextPage: !second,
                  },
                },
              },
            },
          }),
        )
      },
    )

    await expect(ledger(fetchImplementation).readCommentHistory(573)).resolves.toEqual({
      trustedActor: 'jarmak-personal',
      comments: [
        {
          body: 'first body',
          authorLogin: 'jarmak-personal',
          createdAt: '2026-08-17T12:00:00Z',
          updatedAt: '2026-08-17T12:00:00Z',
        },
        {
          body: 'second body',
          authorLogin: null,
          createdAt: '2026-08-17T12:00:00Z',
          updatedAt: '2026-08-17T12:00:00Z',
        },
      ],
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(
      queries.every(
        (query) =>
          !/\b(?:title|databaseId|url|id)\b/.test(query) &&
          query.includes('comments(first: 100') &&
          query.includes('author { login }') &&
          query.includes('createdAt') &&
          query.includes('updatedAt'),
      ),
    ).toBe(true)
  })

  it('posts the exact generated comment once and requires body confirmation', async () => {
    const fetchImplementation = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const target =
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        expect(target).toContain('/issues/573/comments')
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe(JSON.stringify({ body: 'exact comment' }))
        return Promise.resolve(
          jsonResponse(
            {
              body: 'exact comment',
              user: { login: 'JARMAK-PERSONAL' },
              created_at: '2026-08-17T12:00:00Z',
              updated_at: '2026-08-17T12:00:00Z',
            },
            201,
          ),
        )
      },
    )

    await expect(
      ledger(fetchImplementation).appendComment(573, 'exact comment'),
    ).resolves.toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry an uncertain POST inside the transport boundary', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'temporary' }, 500)),
    )

    await expect(
      ledger(fetchImplementation).appendComment(573, 'exact comment'),
    ).rejects.toBeInstanceOf(AgentWorkAppendUncertainError)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a conclusive rejection from uncertain network and response failures', async () => {
    const rejectedFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'invalid' }, 422)),
    )
    await expect(
      ledger(rejectedFetch).appendComment(573, 'exact comment'),
    ).rejects.toBeInstanceOf(AgentWorkAppendRejectedError)

    const networkFetch = vi.fn(() => Promise.reject(new Error('private failure detail')))
    await expect(
      ledger(networkFetch).appendComment(573, 'exact comment'),
    ).rejects.toBeInstanceOf(AgentWorkAppendUncertainError)
    expect(networkFetch).toHaveBeenCalledTimes(1)

    const malformedFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ id: 'hidden' }, 201)),
    )
    await expect(
      ledger(malformedFetch).appendComment(573, 'exact comment'),
    ).rejects.toBeInstanceOf(AgentWorkAppendUncertainError)
  })

  it('treats an unexpected append author or edited response as uncertain', async () => {
    for (const response of [
      {
        body: 'exact comment',
        user: { login: 'forged-author' },
        created_at: '2026-08-17T12:00:00Z',
        updated_at: '2026-08-17T12:00:00Z',
      },
      {
        body: 'exact comment',
        user: { login: 'jarmak-personal' },
        created_at: '2026-08-17T12:00:00Z',
        updated_at: '2026-08-17T12:01:00Z',
      },
    ]) {
      const fetchImplementation = vi.fn(() =>
        Promise.resolve(jsonResponse(response, 201)),
      )
      await expect(
        ledger(fetchImplementation).appendComment(573, 'exact comment'),
      ).rejects.toBeInstanceOf(AgentWorkAppendUncertainError)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    }
  })

  it('fails a missing issue without exposing raw response data', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ repository: { issue: null } })),
    )

    await expect(ledger(fetchImplementation).readCommentHistory(573)).rejects.toThrow(
      '#573',
    )
  })
})
