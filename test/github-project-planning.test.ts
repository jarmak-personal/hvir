import { describe, expect, it, vi } from 'vitest'

import { GitHubCanonicalProject } from '../scripts/project-management/canonical-project.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'
import { GitHubIssueRepository } from '../scripts/project-management/github-issues.ts'

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
  if (typeof init?.body !== 'string') throw new Error('Expected a GraphQL body.')
  const parsed = JSON.parse(init.body) as {
    query: string
    variables: Record<string, unknown>
  }
  return parsed
}

function client(token: string, fetchImplementation: typeof fetch): GitHubClient {
  return new GitHubClient({
    token,
    purpose: 'test',
    fetchImplementation,
    wait: vi.fn().mockResolvedValue(undefined),
  })
}

const kindOptions = [
  'Epic',
  'Feature',
  'Bug',
  'Refactor',
  'Docs',
  'Maintenance',
  'Enhancement',
]

function field(name: string, options: string[]): object {
  return {
    __typename: 'ProjectV2SingleSelectField',
    id: `${name.toLowerCase()}-field`,
    name,
    options: options.map((option) => ({ id: `option-${option}`, name: option })),
  }
}

function canonicalProject(fetchImplementation: typeof fetch): GitHubCanonicalProject {
  return new GitHubCanonicalProject({
    owner: 'jarmak-personal',
    number: 1,
    repositoryOwner: 'jarmak-personal',
    repositoryName: 'hvir',
    client: client('project-token', fetchImplementation),
  })
}

describe('GitHub issue planning adapter', () => {
  it('paginates and classifies native issue and pull-request relationships', async () => {
    const queries: string[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        queries.push(body.query)
        if (body.query.includes('IssueKind')) {
          const second = body.variables.after === 'labels-next'
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  id: 'issue-id',
                  number: 85,
                  state: 'OPEN',
                  updatedAt: '2026-07-20T22:13:01Z',
                  labels: {
                    nodes: [{ name: second ? 'area:docs' : 'kind:feature' }],
                    pageInfo: {
                      endCursor: second ? null : 'labels-next',
                      hasNextPage: !second,
                    },
                  },
                },
              },
            }),
          )
        }
        if (body.query.includes('IssueParent')) {
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  parent: {
                    number: 50,
                    state: 'OPEN',
                    repository: { nameWithOwner: 'jarmak-personal/hvir' },
                  },
                },
              },
            }),
          )
        }
        if (body.query.includes('IssueSubIssues')) {
          const second = body.variables.after === 'subs-next'
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  subIssues: {
                    nodes: [
                      {
                        number: second ? 87 : 86,
                        state: 'OPEN',
                        repository: { nameWithOwner: 'jarmak-personal/hvir' },
                      },
                    ],
                    pageInfo: {
                      endCursor: second ? null : 'subs-next',
                      hasNextPage: !second,
                    },
                  },
                },
              },
            }),
          )
        }
        if (body.query.includes('IssuePullRequests')) {
          const manuallyLinked = body.variables.userLinkedOnly === true
          const second = body.variables.after === 'prs-next'
          const nodes = manuallyLinked
            ? [
                {
                  number: 90,
                  state: 'OPEN',
                  mergedAt: null,
                  repository: { nameWithOwner: 'jarmak-personal/hvir' },
                },
              ]
            : [
                {
                  number: second ? 90 : 89,
                  state: second ? 'OPEN' : 'MERGED',
                  mergedAt: second ? null : '2026-07-20T22:06:43Z',
                  repository: { nameWithOwner: 'jarmak-personal/hvir' },
                },
              ]
          return Promise.resolve(
            graphqlData({
              repository: {
                issue: {
                  closedByPullRequestsReferences: {
                    nodes,
                    pageInfo: {
                      endCursor: manuallyLinked || second ? null : 'prs-next',
                      hasNextPage: !manuallyLinked && !second,
                    },
                  },
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${body.query}`)
      },
    )
    const issues = new GitHubIssueRepository({
      owner: 'jarmak-personal',
      name: 'hvir',
      client: client('repo-token', fetchImplementation),
    })

    await expect(issues.getPlanningIssue(85)).resolves.toMatchObject({
      labels: ['kind:feature', 'area:docs'],
      parent: { number: 50 },
      subIssues: [{ number: 86 }, { number: 87 }],
      linkedPullRequests: [
        { number: 89, relationship: 'closing' },
        { number: 90, relationship: 'linked' },
      ],
    })
    expect(queries.every((query) => !/\b(title|body|comments)\b/.test(query))).toBe(true)
  })

  it('identifies a configured repository mismatch without returning raw data', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ repository: null })),
    )
    const issues = new GitHubIssueRepository({
      owner: 'wrong-owner',
      name: 'wrong-repository',
      client: client('repo-token', fetchImplementation),
    })

    await expect(issues.getIssue(85)).rejects.toThrow('wrong-owner/wrong-repository')
  })
})

describe('canonical Project adapter', () => {
  it('paginates fields and items while matching repository-qualified issues', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        if (body.query.includes('ProjectIdentity')) {
          return Promise.resolve(
            graphqlData({ user: { projectV2: { id: 'project-id' } } }),
          )
        }
        if (body.query.includes('ProjectFields')) {
          const second = body.variables.after === 'fields-next'
          return Promise.resolve(
            graphqlData({
              node: {
                fields: {
                  nodes: [
                    second
                      ? field('Status', ['Todo', 'In Progress', 'Done'])
                      : field('Kind', kindOptions),
                  ],
                  pageInfo: {
                    endCursor: second ? null : 'fields-next',
                    hasNextPage: !second,
                  },
                },
              },
            }),
          )
        }
        if (body.query.includes('ProjectItemById')) {
          expect(body.variables.itemId).toBe('target-item')
          return Promise.resolve(
            graphqlData({
              node: {
                __typename: 'ProjectV2Item',
                id: 'target-item',
                isArchived: false,
                content: {
                  __typename: 'Issue',
                  number: 85,
                  repository: { nameWithOwner: 'jarmak-personal/hvir' },
                },
                kind: {
                  __typename: 'ProjectV2ItemFieldSingleSelectValue',
                  name: 'Feature',
                },
                status: {
                  __typename: 'ProjectV2ItemFieldSingleSelectValue',
                  name: 'In Progress',
                },
              },
            }),
          )
        }
        if (body.query.includes('ProjectItems')) {
          const second = body.variables.after === 'items-next'
          return Promise.resolve(
            graphqlData({
              node: {
                items: {
                  nodes: [
                    {
                      id: second ? 'target-item' : 'other-repository-item',
                      isArchived: second,
                      content: {
                        __typename: 'Issue',
                        number: 85,
                        repository: {
                          nameWithOwner: second
                            ? 'jarmak-personal/hvir'
                            : 'another/repository',
                        },
                      },
                      kind: {
                        __typename: 'ProjectV2ItemFieldSingleSelectValue',
                        name: 'Feature',
                      },
                      status: {
                        __typename: 'ProjectV2ItemFieldSingleSelectValue',
                        name: 'Todo',
                      },
                    },
                  ],
                  pageInfo: {
                    endCursor: second ? null : 'items-next',
                    hasNextPage: !second,
                  },
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${body.query}`)
      },
    )
    const project = canonicalProject(fetchImplementation)

    await expect(project.validatePlanningSchema()).resolves.toBeUndefined()
    await expect(project.getIssueItem(85)).resolves.toMatchObject({
      id: 'target-item',
      archived: true,
      repository: 'jarmak-personal/hvir',
      kind: 'Feature',
      status: 'Todo',
    })
    await expect(project.refreshIssueItem(85)).resolves.toMatchObject({
      id: 'target-item',
      archived: false,
      status: 'In Progress',
    })
    const queries = vi
      .mocked(fetchImplementation)
      .mock.calls.map((call) => requestBody(call[1]).query)
    expect(queries.filter((query) => query.includes('ProjectItems'))).toHaveLength(2)
    expect(queries.filter((query) => query.includes('ProjectItemById'))).toHaveLength(1)
  })

  it('reports missing Status schema before scanning Project items', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        if (body.query.includes('ProjectIdentity')) {
          return Promise.resolve(
            graphqlData({ user: { projectV2: { id: 'project-id' } } }),
          )
        }
        if (body.query.includes('ProjectFields')) {
          return Promise.resolve(
            graphqlData({
              node: {
                fields: {
                  nodes: [field('Kind', kindOptions)],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            }),
          )
        }
        throw new Error('Project items must not be queried after schema drift.')
      },
    )

    await expect(
      canonicalProject(fetchImplementation).validatePlanningSchema(),
    ).rejects.toThrow('Project field "Status" is missing')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate Project items for one repository issue', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        if (body.query.includes('ProjectIdentity')) {
          return Promise.resolve(
            graphqlData({ user: { projectV2: { id: 'project-id' } } }),
          )
        }
        if (body.query.includes('ProjectFields')) {
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
        }
        if (body.query.includes('ProjectItems')) {
          const duplicate = (id: string): object => ({
            id,
            isArchived: false,
            content: {
              __typename: 'Issue',
              number: 85,
              repository: { nameWithOwner: 'jarmak-personal/hvir' },
            },
            kind: null,
            status: null,
          })
          return Promise.resolve(
            graphqlData({
              node: {
                items: {
                  nodes: [duplicate('first-item'), duplicate('second-item')],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            }),
          )
        }
        throw new Error(`Unexpected query: ${body.query}`)
      },
    )

    await expect(canonicalProject(fetchImplementation).getIssueItem(85)).rejects.toThrow(
      'more than one item for jarmak-personal/hvir#85',
    )
  })

  it('adds, restores, and updates through named idempotent operations', async () => {
    const queries: string[] = []
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init)
        queries.push(body.query)
        if (body.query.includes('ProjectIdentity')) {
          return Promise.resolve(
            graphqlData({ user: { projectV2: { id: 'project-id' } } }),
          )
        }
        if (body.query.includes('ProjectFields')) {
          return Promise.resolve(
            graphqlData({
              node: {
                fields: {
                  nodes: [
                    field('Kind', kindOptions),
                    field('Status', ['Todo', 'In Progress', 'Done']),
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
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            }),
          )
        }
        if (body.query.includes('AddProjectItem')) {
          return Promise.resolve(
            graphqlData({
              addProjectV2ItemById: {
                item: { id: 'new-item', isArchived: false },
              },
            }),
          )
        }
        if (body.query.includes('RestoreProjectItem')) {
          return Promise.resolve(
            graphqlData({
              unarchiveProjectV2Item: {
                item: { id: 'new-item', isArchived: false },
              },
            }),
          )
        }
        if (body.query.includes('SetProjectSingleSelect')) {
          return Promise.resolve(
            graphqlData({
              updateProjectV2ItemFieldValue: { projectV2Item: { id: 'new-item' } },
            }),
          )
        }
        throw new Error(`Unexpected query: ${body.query}`)
      },
    )
    const project = canonicalProject(fetchImplementation)
    const issue = {
      id: 'issue-id',
      number: 85,
      state: 'OPEN' as const,
    }

    const added = await project.addIssue(issue)
    expect(await project.addIssue(issue)).toBe(added)
    await expect(project.setStatus(added, 'In Progress')).resolves.toBeUndefined()
    await expect(project.setStatus(added, 'In Progress')).resolves.toBeUndefined()
    added.archived = true
    await expect(project.unarchiveIssue(issue, added)).resolves.toMatchObject({
      archived: false,
    })
    await expect(project.unarchiveIssue(issue, added)).resolves.toBe(added)

    expect(queries.filter((query) => query.includes('AddProjectItem'))).toHaveLength(1)
    expect(
      queries.filter((query) => query.includes('SetProjectSingleSelect')),
    ).toHaveLength(1)
    expect(queries.filter((query) => query.includes('RestoreProjectItem'))).toHaveLength(
      1,
    )
  })

  it('reports a wrong or unreadable canonical Project by configured identity', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(graphqlData({ user: { projectV2: null } })),
    )

    await expect(
      canonicalProject(fetchImplementation).validatePlanningSchema(),
    ).rejects.toThrow('User Project jarmak-personal#1 was not found')
  })

  it('reports a missing canonical Status option as schema drift', async () => {
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
                nodes: [
                  field('Kind', kindOptions),
                  field('Status', ['Todo', 'In Progress']),
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          }),
        )
      },
    )

    await expect(
      canonicalProject(fetchImplementation).validatePlanningSchema(),
    ).rejects.toThrow('Project field "Status" is missing the expected "Done" option')
  })

  it('redacts a token from GraphQL failure diagnostics', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          errors: [
            {
              type: 'FORBIDDEN',
              message: 'permission denied for project-token',
            },
          ],
        }),
      ),
    )

    let message = ''
    try {
      await canonicalProject(fetchImplementation).validatePlanningSchema()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('permission denied for [REDACTED]')
    expect(message).not.toContain('project-token')
  })
})
