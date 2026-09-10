import { describe, expect, it } from 'vitest'
import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { projectRecordedTokens } from '../scripts/project-management/project-token-fields.ts'

describe('three-field token Project projection', () => {
  it('retries partial writes, clears unknown phases, supports archived items, and avoids redundant mutations', async () => {
    const values: Record<string, number | null> = {
      planning: null,
      implementation: null,
      tokens: null,
    }
    let fail = true
    const writes: string[] = []
    const client = new GitHubClient({
      token: 'private',
      purpose: 'test',
      fetchImplementation: (_url, init) =>
        Promise.resolve().then(() => {
          if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
          const body = JSON.parse(init.body) as {
            query: string
            variables: { value?: number; fieldId: string }
          }
          if (body.query.includes('RecordedTokenFields'))
            return new Response(
              JSON.stringify({
                data: {
                  node: Object.fromEntries(
                    Object.entries(values).map(([key, value]) => [
                      key,
                      value === null ? null : { number: value },
                    ]),
                  ),
                },
              }),
            )
          const key = body.variables.fieldId
          writes.push(key)
          if (key === 'tokens' && fail)
            return new Response(JSON.stringify({ errors: [{ message: 'unavailable' }] }))
          values[key] = body.variables.value ?? null
          return new Response(JSON.stringify({ data: {} }))
        }),
    })
    const input = {
      client,
      schema: {
        id: 'project',
        fields: [
          ['Planning tokens', 'planning'],
          ['Implementation tokens', 'implementation'],
          ['Total tokens', 'tokens'],
        ].map(([name, id]) => ({
          typename: 'ProjectV2Field',
          id: id!,
          name: name!,
          dataType: 'NUMBER',
        })),
      },
      item: {
        id: 'item',
        archived: true,
        repository: 'owner/repo',
        issueNumber: 757,
        kind: null,
        status: null,
      },
      tokens: { planning: 40, implementation: 60, tokens: 100 },
    }
    await expect(projectRecordedTokens(input)).rejects.toThrow()
    expect(values).toEqual({ planning: 40, implementation: 60, tokens: null })
    fail = false
    await projectRecordedTokens(input)
    await projectRecordedTokens(input)
    expect(writes).toEqual(['planning', 'implementation', 'tokens', 'tokens'])
    await projectRecordedTokens({
      ...input,
      tokens: { planning: null, implementation: null, tokens: 120 },
    })
    expect(values).toEqual({ planning: null, implementation: null, tokens: 120 })
    await expect(
      projectRecordedTokens({
        ...input,
        tokens: { planning: 40, implementation: 60, tokens: -1 },
      }),
    ).rejects.toThrow('Invalid tokens')
  })
})
