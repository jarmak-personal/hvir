import { describe, expect, it } from 'vitest'
import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { projectRecordedTokens } from '../scripts/project-management/project-token-fields.ts'
import { TOKEN_SCOPE } from '../scripts/project-management/session-token-receipts.ts'

describe('recorded token Project projection', () => {
  it('labels before publishing, retries partial writes, and converges without duplicate mutations', async () => {
    let scope: string | null = null
    let tokens: number | null = null
    let fail = true
    const writes: string[] = []
    const client = new GitHubClient({
      token: 'private',
      purpose: 'test',
      fetchImplementation: (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
        const body = JSON.parse(init.body) as {
          query: string
          variables: { value?: string | number }
        }
        if (body.query.includes('RecordedTokenFields'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  node: {
                    tokens: tokens === null ? null : { number: tokens },
                    scope: scope === null ? null : { text: scope },
                  },
                },
              }),
            ),
          )
        if (body.query.includes('SetProjectText')) {
          scope = TOKEN_SCOPE
          writes.push('scope')
        } else {
          writes.push('tokens')
          if (fail)
            return Promise.resolve(
              new Response(JSON.stringify({ errors: [{ message: 'unavailable' }] })),
            )
          tokens = 100
        }
        return Promise.resolve(new Response(JSON.stringify({ data: {} })))
      },
    })
    const input = {
      client,
      schema: {
        id: 'project',
        fields: [
          {
            typename: 'ProjectV2Field',
            id: 'tokens',
            name: 'Recorded tokens',
            dataType: 'NUMBER',
          },
          {
            typename: 'ProjectV2Field',
            id: 'scope',
            name: 'Token scope',
            dataType: 'TEXT',
          },
        ],
      },
      item: {
        id: 'item',
        archived: false,
        repository: 'owner/repo',
        issueNumber: 757,
        kind: null,
        status: null,
      },
      tokens: 100,
    }
    await expect(projectRecordedTokens(input)).rejects.toThrow()
    expect(scope).toBe(TOKEN_SCOPE)
    expect(tokens).toBeNull()
    fail = false
    await projectRecordedTokens(input)
    await projectRecordedTokens(input)
    expect(writes).toEqual(['scope', 'tokens', 'tokens'])
    await expect(projectRecordedTokens({ ...input, tokens: -1 })).rejects.toThrow(
      'Invalid tokens',
    )
    await expect(
      projectRecordedTokens({ ...input, item: { ...input.item, archived: true } }),
    ).rejects.toThrow('unavailable')
  })
})
