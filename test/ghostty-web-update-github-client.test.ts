import { describe, expect, it, vi } from 'vitest'

import { BoundedGitHubClient } from '../scripts/ghostty-web-update/github-client.mts'

describe('ghostty-web bounded GitHub client', () => {
  it('bounds transient retries and never exposes an arbitrary response body', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ arbitrary: 'untrusted diagnostic' }, 502)),
    )
    const wait = vi.fn(() => Promise.resolve())
    const client = new BoundedGitHubClient({ fetchImplementation, wait })

    await expect(client.json('/repos/example/releases')).rejects.toThrow(
      'GitHub request failed with HTTP 502.',
    )
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('rejects a response before retaining bytes beyond the caller bound', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(response('oversized', 200, { 'content-length': '9' })),
    )
    const client = new BoundedGitHubClient({ fetchImplementation })

    await expect(client.bytes('/repos/example/releases', {}, 8)).rejects.toThrow(
      'exceeds its bounded size',
    )
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })
})

function response(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const value = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers,
    status,
  })
  Object.defineProperty(value, 'url', {
    configurable: true,
    value: 'https://api.github.com/repos/example/releases',
  })
  return value
}
