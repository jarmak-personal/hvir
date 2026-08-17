import { describe, expect, it, vi } from 'vitest'

import { AGENT_WORK_PROJECT_FIELDS } from '../scripts/project-management/agent-work-project-fields.ts'
import { GitHubCanonicalProject } from '../scripts/project-management/canonical-project.ts'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  type CanonicalProjectConfiguration,
} from '../scripts/project-management/canonical-project-config.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'

describe('canonical Project public configuration', () => {
  it('stores one complete deployment contract for planning and measurement fields', () => {
    const names = CANONICAL_PROJECT_CONFIGURATION.fields.map((field) => field.name)
    expect(names).toEqual([
      'Status',
      'Kind',
      ...AGENT_WORK_PROJECT_FIELDS.map((field) => field.name),
    ])
    expect(
      new Set(CANONICAL_PROJECT_CONFIGURATION.fields.map((field) => field.id)).size,
    ).toBe(CANONICAL_PROJECT_CONFIGURATION.fields.length)
    expect(
      CANONICAL_PROJECT_CONFIGURATION.fields.flatMap(
        (field) => field.options?.map((option) => option.id) ?? [],
      ),
    ).toHaveLength(24)
  })

  it('audits the exact Project, fields, and options through the named live path', async () => {
    const queries: string[] = []
    const project = canonicalProject(
      auditFetch(CANONICAL_PROJECT_CONFIGURATION, {
        paginateAt: 8,
        queries,
      }),
    )

    await expect(project.auditConfiguration()).resolves.toEqual({
      outcome: 'valid',
      project: { owner: 'jarmak-personal', number: 1 },
      diagnostics: [],
    })
    expect(queries.filter((query) => query.includes('ProjectIdentity'))).toHaveLength(1)
    expect(queries.filter((query) => query.includes('ProjectFields'))).toHaveLength(2)
    expect(queries.some((query) => query.includes('IssueProjectItems'))).toBe(false)
    expect(queries.some((query) => query.includes('query ProjectItems'))).toBe(false)
  })

  it.each([
    {
      label: 'Project ID',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        id: 'replacement-project-id',
      }),
      diagnostic: 'Project node ID',
    },
    {
      label: 'field ID',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        fields: configuration.fields.map((field, index) =>
          index === 0 ? { ...field, id: 'replacement-field-id' } : field,
        ),
      }),
      diagnostic: 'stored node ID for Project field "Status"',
    },
    {
      label: 'field name',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        fields: configuration.fields.map((field, index) =>
          index === 0 ? { ...field, name: 'Renamed status' } : field,
        ),
      }),
      diagnostic: 'Project field "Status" was renamed',
    },
    {
      label: 'field type',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        fields: configuration.fields.map((field) =>
          field.name === 'Agent difficulty' ? { ...field, dataType: 'TEXT' } : field,
        ),
      }),
      diagnostic: 'Agent difficulty" no longer has its configured type',
    },
    {
      label: 'option ID set',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        fields: configuration.fields.map((field) =>
          field.name === 'Risk' ? { ...field, options: field.options?.slice(1) } : field,
        ),
      }),
      diagnostic: 'stored node ID for Project option "Risk / Low"',
    },
    {
      label: 'option name',
      mutate: (configuration: CanonicalProjectConfiguration) => ({
        ...configuration,
        fields: configuration.fields.map((field) =>
          field.name === 'Risk'
            ? {
                ...field,
                options: field.options?.map((option, index) =>
                  index === 0 ? { ...option, name: 'Renamed low' } : option,
                ),
              }
            : field,
        ),
      }),
      diagnostic: 'Risk / Low" was renamed',
    },
  ])('reports actionable $label drift', async ({ mutate, diagnostic }) => {
    const live = mutate(CANONICAL_PROJECT_CONFIGURATION)
    const report = await canonicalProject(auditFetch(live)).auditConfiguration()

    expect(report.outcome).toBe('drift')
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining(diagnostic)]),
    )
  })

  it.each([
    {
      label: 'repository',
      repositoryOwner: 'another-owner',
      projectOwner: 'jarmak-personal',
      projectNumber: 1,
    },
    {
      label: 'Project owner',
      repositoryOwner: 'jarmak-personal',
      projectOwner: 'another-owner',
      projectNumber: 1,
    },
    {
      label: 'Project number',
      repositoryOwner: 'jarmak-personal',
      projectOwner: 'jarmak-personal',
      projectNumber: 2,
    },
  ])(
    'fails closed when a $label override would reuse canonical IDs elsewhere',
    ({ repositoryOwner, projectOwner, projectNumber }) => {
      expect(
        () =>
          new GitHubCanonicalProject({
            owner: projectOwner,
            number: projectNumber,
            repositoryOwner,
            repositoryName: 'hvir',
            client: client(vi.fn()),
          }),
      ).toThrow('do not match the stored canonical Project configuration')
    },
  )
})

function canonicalProject(fetchImplementation: typeof fetch): GitHubCanonicalProject {
  return new GitHubCanonicalProject({
    owner: 'jarmak-personal',
    number: 1,
    repositoryOwner: 'jarmak-personal',
    repositoryName: 'hvir',
    client: client(fetchImplementation),
  })
}

function auditFetch(
  live: CanonicalProjectConfiguration,
  options: { paginateAt?: number; queries?: string[] } = {},
): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init)
    options.queries?.push(body.query)
    if (body.query.includes('ProjectIdentity')) {
      return Promise.resolve(graphqlData({ user: { projectV2: { id: live.id } } }))
    }
    if (body.query.includes('ProjectFields')) {
      const split = options.paginateAt
      const second = body.variables.after === 'fields-next'
      const fields =
        split === undefined
          ? live.fields
          : second
            ? live.fields.slice(split)
            : live.fields.slice(0, split)
      return Promise.resolve(
        graphqlData({
          node: {
            fields: {
              nodes: fields.map((field) => ({
                __typename: field.typename,
                id: field.id,
                name: field.name,
                ...(field.dataType === undefined ? {} : { dataType: field.dataType }),
                ...(field.options === undefined ? {} : { options: field.options }),
              })),
              pageInfo: {
                endCursor: split !== undefined && !second ? 'fields-next' : null,
                hasNextPage: split !== undefined && !second,
              },
            },
          },
        }),
      )
    }
    throw new Error(`Unexpected query: ${body.query}`)
  })
}

function client(fetchImplementation: typeof fetch): GitHubClient {
  return new GitHubClient({
    token: 'project-token',
    purpose: 'test',
    fetchImplementation,
    wait: vi.fn().mockResolvedValue(undefined),
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

function graphqlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
