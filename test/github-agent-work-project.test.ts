import { describe, expect, it, vi } from 'vitest'

import { AGENT_WORK_PROJECT_FIELDS } from '../scripts/project-management/agent-work-project-fields.ts'
import { GitHubCanonicalProject } from '../scripts/project-management/canonical-project.ts'
import { GitHubClient } from '../scripts/project-management/github-client.ts'

describe('GitHub agent-work Project adapter', () => {
  it('paginates the typed schema, reads named values, and writes every field type', async () => {
    const mutations: Array<{ query: string; variables: Record<string, unknown> }> = []
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
          const fields = measurementFields()
          return Promise.resolve(
            graphqlData({
              node: {
                fields: {
                  nodes: second ? fields.slice(6) : fields.slice(0, 6),
                  pageInfo: {
                    endCursor: second ? null : 'fields-next',
                    hasNextPage: !second,
                  },
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
                  nodes: [projectItem(false)],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            }),
          )
        }
        if (body.query.includes('AgentWorkProjectValues')) {
          return Promise.resolve(
            graphqlData({
              node: {
                __typename: 'ProjectV2Item',
                measurement0: {
                  __typename: 'ProjectV2ItemFieldNumberValue',
                  number: 3,
                },
                measurement1: {
                  __typename: 'ProjectV2ItemFieldSingleSelectValue',
                  name: 'Moderate',
                },
                measurement2: null,
                measurement3: {
                  __typename: 'ProjectV2ItemFieldTextValue',
                  text: 'gpt-5.6-sol',
                },
                ...Object.fromEntries(
                  AGENT_WORK_PROJECT_FIELDS.slice(4).map((_field, index) => [
                    `measurement${index + 4}`,
                    null,
                  ]),
                ),
              },
            }),
          )
        }
        if (
          body.query.includes('SetProjectNumber') ||
          body.query.includes('SetProjectText') ||
          body.query.includes('SetProjectSingleSelect') ||
          body.query.includes('ClearProjectField')
        ) {
          mutations.push(body)
          const key = body.query.includes('ClearProjectField')
            ? 'clearProjectV2ItemFieldValue'
            : 'updateProjectV2ItemFieldValue'
          return Promise.resolve(
            graphqlData({ [key]: { projectV2Item: { id: 'item-id' } } }),
          )
        }
        throw new Error(`Unexpected query: ${body.query}`)
      },
    )
    const project = canonicalProject(fetchImplementation)

    await expect(project.readAgentWorkProjection(574)).resolves.toEqual({
      'Agent difficulty': 3,
      Risk: 'Moderate',
      'Initial model': 'gpt-5.6-sol',
    })
    await project.setAgentWorkProjectionField(574, 'Agent difficulty', 4)
    await project.setAgentWorkProjectionField(574, 'Initial model', 'claude-opus-4-1')
    await project.setAgentWorkProjectionField(574, 'Risk', 'High')
    await project.setAgentWorkProjectionField(574, 'Planning tokens', undefined)

    expect(mutations.map(({ query }) => query)).toEqual([
      expect.stringContaining('SetProjectNumber'),
      expect.stringContaining('SetProjectText'),
      expect.stringContaining('SetProjectSingleSelect'),
      expect.stringContaining('ClearProjectField'),
    ])
    expect(mutations[0]?.variables).toMatchObject({
      projectId: 'project-id',
      itemId: 'item-id',
      fieldId: 'agent-difficulty-field',
      value: 4,
    })
    expect(mutations[2]?.variables.optionId).toBe('risk-High')
  })

  it('fails closed on missing, duplicate, wrong-type, and invalid-option schema', async () => {
    for (const [fields, message] of [
      [
        measurementFields().filter((field) => field.name !== 'Initial model'),
        'Project field "Initial model" is missing',
      ],
      [
        [...measurementFields(), numberField('Agent difficulty')],
        'more than one field named "Agent difficulty"',
      ],
      [
        measurementFields().map((field) =>
          field.name === 'Initial model' ? numberField('Initial model') : field,
        ),
        '"Initial model" exists but is not a text field',
      ],
      [
        measurementFields().map((field) =>
          field.name === 'Risk'
            ? singleSelectField('Risk', ['Low', 'Moderate', 'High'])
            : field,
        ),
        'Project field "Risk" is missing the expected "Critical" option',
      ],
    ] as const) {
      const project = canonicalProject(schemaFetch([...fields]))
      await expect(project.readAgentWorkProjection(574)).rejects.toThrow(message)
    }
  })

  it('rejects missing and archived Project items before mutation', async () => {
    await expect(
      canonicalProject(schemaFetch(measurementFields(), [])).readAgentWorkProjection(574),
    ).rejects.toThrow('missing from the canonical Project')
    await expect(
      canonicalProject(
        schemaFetch(measurementFields(), [projectItem(true)]),
      ).readAgentWorkProjection(574),
    ).rejects.toThrow('archived in the canonical Project')
  })
})

function schemaFetch(
  fields: object[],
  items: object[] = [projectItem(false)],
): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init)
    if (body.query.includes('ProjectIdentity')) {
      return Promise.resolve(graphqlData({ user: { projectV2: { id: 'project-id' } } }))
    }
    if (body.query.includes('ProjectFields')) {
      return Promise.resolve(
        graphqlData({
          node: {
            fields: {
              nodes: fields,
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
              nodes: items,
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }),
      )
    }
    throw new Error(`Unexpected query: ${body.query}`)
  })
}

function measurementFields(): Array<Record<string, unknown>> {
  return AGENT_WORK_PROJECT_FIELDS.map((field) => {
    if (field.type === 'number') return numberField(field.name)
    if (field.type === 'text') return textField(field.name)
    return singleSelectField(field.name, [...field.options])
  })
}

function numberField(name: string): Record<string, unknown> {
  return {
    __typename: 'ProjectV2Field',
    id: `${slug(name)}-field`,
    name,
    dataType: 'NUMBER',
  }
}

function textField(name: string): Record<string, unknown> {
  return {
    __typename: 'ProjectV2Field',
    id: `${slug(name)}-field`,
    name,
    dataType: 'TEXT',
  }
}

function singleSelectField(name: string, options: string[]): Record<string, unknown> {
  return {
    __typename: 'ProjectV2SingleSelectField',
    id: `${slug(name)}-field`,
    name,
    options: options.map((option) => ({ id: `${slug(name)}-${option}`, name: option })),
  }
}

function projectItem(archived: boolean): object {
  return {
    id: 'item-id',
    isArchived: archived,
    content: {
      __typename: 'Issue',
      number: 574,
      repository: { nameWithOwner: 'jarmak-personal/hvir' },
    },
    kind: null,
    status: null,
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z]+/g, '-')
    .replace(/-$/, '')
}

function canonicalProject(fetchImplementation: typeof fetch): GitHubCanonicalProject {
  return new GitHubCanonicalProject({
    owner: 'jarmak-personal',
    number: 1,
    repositoryOwner: 'jarmak-personal',
    repositoryName: 'hvir',
    client: new GitHubClient({
      token: 'project-token',
      purpose: 'test',
      fetchImplementation,
      wait: vi.fn().mockResolvedValue(undefined),
    }),
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
