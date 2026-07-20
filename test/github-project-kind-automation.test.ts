import { describe, expect, it, vi } from 'vitest'

import { GitHubKindAutomation } from '../scripts/project-management/github-kind-automation.ts'

function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function graphqlData(data: unknown): Response {
  return jsonResponse({ data })
}

function automation(fetchImplementation: typeof fetch): GitHubKindAutomation {
  return new GitHubKindAutomation({
    repositoryOwner: 'jarmak-personal',
    repositoryName: 'hvir',
    projectOwner: 'jarmak-personal',
    projectNumber: 1,
    repositoryToken: 'repo-token',
    projectToken: 'project-token',
    fetchImplementation,
    wait: vi.fn().mockResolvedValue(undefined),
  })
}

function requestBody(init: RequestInit | undefined): {
  query: string
  variables: Record<string, unknown>
} {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
  const parsed: unknown = JSON.parse(init.body)
  if (
    !isRecord(parsed) ||
    typeof parsed.query !== 'string' ||
    !isRecord(parsed.variables)
  ) {
    throw new Error('Expected a GraphQL request body.')
  }
  return { query: parsed.query, variables: parsed.variables }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const expectedOptions = [
  'Epic',
  'Feature',
  'Bug',
  'Refactor',
  'Docs',
  'Maintenance',
  'Enhancement',
]

function projectFetch(
  options: { currentOption?: string; itemMissing?: boolean } = {},
): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = requestBody(init)
    if (body.query.includes('ProjectIdentity')) {
      return Promise.resolve(graphqlData({ user: { projectV2: { id: 'project-id' } } }))
    }
    if (body.query.includes('ProjectFields')) {
      return Promise.resolve(
        graphqlData({
          node: {
            fields: {
              nodes: [
                {
                  __typename: 'ProjectV2SingleSelectField',
                  id: 'kind-field',
                  name: 'Kind',
                  options: expectedOptions.map((name) => ({
                    id: `option-${name}`,
                    name,
                  })),
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }),
      )
    }
    if (body.query.includes('ProjectItems')) {
      return Promise.resolve(
        graphqlData({
          node: {
            items: {
              nodes: options.itemMissing
                ? []
                : [
                    {
                      id: 'item-id',
                      isArchived: false,
                      content: {
                        __typename: 'Issue',
                        number: 10,
                        repository: { nameWithOwner: 'jarmak-personal/hvir' },
                      },
                      fieldValueByName:
                        options.currentOption === undefined
                          ? null
                          : {
                              __typename: 'ProjectV2ItemFieldSingleSelectValue',
                              name: options.currentOption,
                              optionId: `option-${options.currentOption}`,
                            },
                    },
                  ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }),
      )
    }
    if (body.query.includes('AddProjectItem')) {
      return Promise.resolve(
        graphqlData({
          addProjectV2ItemById: { item: { id: 'new-item', isArchived: false } },
        }),
      )
    }
    if (body.query.includes('SetProjectKind')) {
      return Promise.resolve(
        graphqlData({
          updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-id' } },
        }),
      )
    }
    throw new Error(`Unexpected query: ${body.query}`)
  })
}

describe('GitHub project kind adapter', () => {
  it('encodes label mutations and treats an already-removed label as a no-op', async () => {
    const fetchImplementation = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path =
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        if (init?.method === 'DELETE') {
          expect(path).toContain('/labels/kind%3Afeature')
          return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
        }
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe(JSON.stringify({ labels: ['kind:docs'] }))
        return Promise.resolve(jsonResponse([]))
      },
    )
    const adapter = automation(fetchImplementation)

    await expect(adapter.removeLabel(10, 'kind:feature')).resolves.toBeUndefined()
    await expect(adapter.addLabels(10, ['kind:docs'])).resolves.toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('paginates issue labels', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        const secondPage = body.variables.after === 'next-labels'
        return Promise.resolve(
          graphqlData({
            repository: {
              issue: {
                id: 'issue-id',
                number: 10,
                state: 'OPEN',
                updatedAt: '2026-07-20T10:00:00Z',
                labels: {
                  nodes: [{ name: secondPage ? 'area:terminal' : 'kind:feature' }],
                  pageInfo: {
                    endCursor: secondPage ? null : 'next-labels',
                    hasNextPage: !secondPage,
                  },
                },
              },
            },
          }),
        )
      },
    )

    await expect(automation(fetchImplementation).getIssue(10)).resolves.toMatchObject({
      labels: ['kind:feature', 'area:terminal'],
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('skips a no-op Project value', async () => {
    const fetchImplementation = projectFetch({ currentOption: 'Feature' })
    const result = await automation(fetchImplementation).syncProjectKind(
      {
        id: 'issue-id',
        number: 10,
        state: 'OPEN',
        updatedAt: '2026-07-20T10:00:00Z',
        labels: ['kind:feature'],
      },
      'Feature',
      true,
    )

    expect(result).toEqual({ action: 'unchanged', issueAdded: false })
    expect(vi.mocked(fetchImplementation)).toHaveBeenCalledTimes(3)
  })

  it('adds a missing item and sets its Kind in apply mode', async () => {
    const fetchImplementation = projectFetch({ itemMissing: true })
    const result = await automation(fetchImplementation).syncProjectKind(
      {
        id: 'issue-id',
        number: 10,
        state: 'OPEN',
        updatedAt: '2026-07-20T10:00:00Z',
        labels: ['kind:feature'],
      },
      'Feature',
      true,
    )

    expect(result).toEqual({ action: 'added-and-updated', issueAdded: true })
    const queries = vi
      .mocked(fetchImplementation)
      .mock.calls.map((call) => requestBody(call[1]).query)
    expect(queries.some((query) => query.includes('AddProjectItem'))).toBe(true)
    expect(queries.some((query) => query.includes('SetProjectKind'))).toBe(true)
  })

  it('reports a missing Kind field without attempting mutation', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        if (body.query.includes('ProjectIdentity')) {
          return Promise.resolve(
            graphqlData({ user: { projectV2: { id: 'project-id' } } }),
          )
        }
        return Promise.resolve(
          graphqlData({
            node: {
              fields: {
                nodes: [],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          }),
        )
      },
    )

    await expect(
      automation(fetchImplementation).syncProjectKind(
        {
          id: 'issue-id',
          number: 10,
          state: 'OPEN',
          updatedAt: '2026-07-20T10:00:00Z',
          labels: ['kind:feature'],
        },
        'Feature',
        false,
      ),
    ).rejects.toThrow('Project field "Kind" is missing')
  })

  it('retries a temporary HTTP failure with bounded backoff', async () => {
    let attempts = 0
    const fetchImplementation = vi.fn((): Promise<Response> => {
      attempts += 1
      if (attempts === 1)
        return Promise.resolve(jsonResponse({ message: 'temporary' }, 500))
      return Promise.resolve(
        graphqlData({
          repository: {
            issue: {
              id: 'issue-id',
              number: 10,
              state: 'OPEN',
              updatedAt: '2026-07-20T10:00:00Z',
              labels: {
                nodes: [{ name: 'kind:feature' }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
      )
    })

    await expect(automation(fetchImplementation).getIssue(10)).resolves.toMatchObject({
      number: 10,
    })
    expect(attempts).toBe(2)
  })

  it('retries a GraphQL rate-limit envelope', async () => {
    let attempts = 0
    const fetchImplementation = vi.fn((): Promise<Response> => {
      attempts += 1
      if (attempts === 1) {
        return Promise.resolve(
          jsonResponse({
            errors: [{ type: 'RATE_LIMITED', message: 'Rate limit reached' }],
          }),
        )
      }
      return Promise.resolve(
        graphqlData({
          repository: {
            issue: {
              id: 'issue-id',
              number: 10,
              state: 'OPEN',
              updatedAt: '2026-07-20T10:00:00Z',
              labels: {
                nodes: [{ name: 'kind:feature' }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        }),
      )
    })

    await expect(automation(fetchImplementation).getIssue(10)).resolves.toMatchObject({
      number: 10,
    })
    expect(attempts).toBe(2)
  })
})
