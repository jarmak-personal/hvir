import { describe, expect, it, vi } from 'vitest'

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

function client(
  fetchImplementation: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): GitHubClient {
  return new GitHubClient({
    token: 'project-token',
    purpose: 'Project',
    fetchImplementation,
    wait,
  })
}

describe('shared project automation GitHub client', () => {
  it('retries a temporary HTTP failure with bounded backoff', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: 'temporary' }, 502))
      .mockResolvedValueOnce(graphqlData({ node: { id: 'project-id' } }))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      client(fetchImplementation, wait).graphql('query Project { node { id } }', {}),
    ).resolves.toEqual({ node: { id: 'project-id' } })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(250)
  })

  it('retries a GraphQL rate-limit envelope with bounded backoff', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ type: 'RATE_LIMITED', message: 'Rate limit reached' }],
        }),
      )
      .mockResolvedValueOnce(graphqlData({ node: { id: 'project-id' } }))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      client(fetchImplementation, wait).graphql('query Project { node { id } }', {}),
    ).resolves.toEqual({ node: { id: 'project-id' } })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(250)
  })

  it('stops after three temporary HTTP failures', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ message: 'temporary' }, 503))
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      client(fetchImplementation, wait).graphql('query Project { node { id } }', {}),
    ).rejects.toThrow('GitHub GraphQL request failed with HTTP 503.')
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenNthCalledWith(1, 250)
    expect(wait).toHaveBeenNthCalledWith(2, 500)
  })
})
