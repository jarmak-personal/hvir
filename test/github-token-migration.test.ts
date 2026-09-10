import { serializeTokenReceipt } from '../scripts/project-management/session-token-receipts.ts'
import { describe, expect, it } from 'vitest'
import { GitHubClient } from '../scripts/project-management/github-client.ts'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  LEGACY_PROJECT_FIELDS,
} from '../scripts/project-management/canonical-project-config.ts'
import {
  readTokenMigrationSnapshot,
  applyTokenMigration,
} from '../scripts/project-management/github-token-migration.ts'
import {
  TOKEN_FIELD_TARGETS,
  TOKEN_DELETION_TARGETS,
} from '../scripts/project-management/token-migration-plan.ts'

function fixture() {
  const fields = [
    ...LEGACY_PROJECT_FIELDS.map((row) => ({
      id: row.id!,
      name: `Legacy: ${row.name}`,
      dataType: row.dataType ?? 'SINGLE_SELECT',
    })),
    { id: TOKEN_FIELD_TARGETS[2].id, name: 'Recorded tokens', dataType: 'NUMBER' },
    { id: 'PVTF_lAHOBkzMzc4Bdudrzhhh8xw', name: 'Token scope', dataType: 'TEXT' },
    { id: 'native', name: 'Title', dataType: 'TITLE' },
  ]
  const lifecycle = LEGACY_PROJECT_FIELDS.find(
    (row) => row.name === 'Lifecycle tokens',
  )!.id!
  const values = new Map<string, number>([
    [lifecycle, 100],
    [TOKEN_FIELD_TARGETS[0].id, 25],
    [TOKEN_FIELD_TARGETS[1].id, 75],
  ])
  const comments: {
    body: string
    author: { login: string }
    createdAt: string
    updatedAt: string
  }[] = []
  const operations: string[] = []
  const queries: string[] = []
  let fail: 'append' | 'project' | 'delete' | undefined
  let appliedDeletes = 0
  const pageInfo = { hasNextPage: false, endCursor: null }
  const response = (data: unknown) => new Response(JSON.stringify({ data }))
  const client = new GitHubClient({
    token: 'private',
    purpose: 'test',
    wait: async () => {},
    fetchImplementation: (url, init) =>
      Promise.resolve().then(() => {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
        const request = JSON.parse(init.body) as {
          body?: string
          query?: string
          variables?: Record<string, string | number | null>
        }
        if (typeof url === 'string' && url.endsWith('/comments')) {
          comments.push({
            body: request.body!,
            author: { login: 'jarmak-personal' },
            createdAt: 'now',
            updatedAt: 'now',
          })
          operations.push('append')
          if (fail === 'append') {
            fail = undefined
            throw new Error('lost response')
          }
          return new Response(
            JSON.stringify({
              body: request.body,
              user: { login: 'jarmak-personal' },
              created_at: 'now',
              updated_at: 'now',
            }),
          )
        }
        const query = request.query!
        const variables = request.variables!
        queries.push(query)
        if (query.includes('TokenMigrationFields'))
          return response({ node: { fields: { nodes: fields, pageInfo } } })
        if (query.includes('TokenMigrationItems'))
          return response({
            node: {
              items: {
                nodes: [
                  {
                    id: 'item',
                    isArchived: true,
                    fieldValues: {
                      nodes: [...values]
                        .filter(([id]) => fields.some((field) => field.id === id))
                        .map(([id, number]) => ({ number, field: { id } })),
                      pageInfo,
                    },
                    content: {
                      __typename: 'Issue',
                      number: 1,
                      repository: {
                        nameWithOwner: CANONICAL_PROJECT_CONFIGURATION.repository,
                      },
                      parent: null,
                      subIssues: { nodes: [], pageInfo },
                      labels: { nodes: [], pageInfo },
                    },
                  },
                ],
                pageInfo,
              },
            },
          })
        if (query.includes('SessionTokenComments'))
          return response({
            repository: { issue: { comments: { nodes: comments, pageInfo } } },
          })
        if (query.includes('RenameTokenField')) {
          expect(comments.length).toBeGreaterThan(0)
          fields.find((row) => row.id === variables.id)!.name = String(variables.name)
          operations.push('rename')
          return response({})
        }
        if (query.includes('SetProjectNumber') || query.includes('ClearProjectField')) {
          operations.push('project')
          if (fail === 'project')
            return new Response(JSON.stringify({ errors: [{ message: 'unavailable' }] }))
          if (query.includes('Clear')) values.delete(String(variables.fieldId))
          else values.set(String(variables.fieldId), Number(variables.value))
          return response({})
        }
        if (query.includes('DeleteRetiredTokenField')) {
          if (fail === 'delete' && appliedDeletes === 1)
            return new Response(JSON.stringify({ errors: [{ message: 'unavailable' }] }))
          operations.push('delete')
          fields.splice(
            fields.findIndex((row) => row.id === variables.id),
            1,
          )
          appliedDeletes++
          return response({})
        }
        throw new Error(`Unexpected test query: ${query}`)
      }),
  })
  return {
    client,
    fields,
    values,
    comments,
    operations,
    queries,
    fail: (value: typeof fail) => {
      fail = value
    },
    lifecycle,
  }
}

describe('GitHub migration preservation and partial failure boundary', () => {
  it('explicitly includes archived and closed issues and never mutates during planning', async () => {
    const f = fixture()
    const snapshot = await readTokenMigrationSnapshot(f.client, f.client)
    expect(snapshot.items[0]?.archived).toBe(true)
    expect(f.queries.find((query) => query.includes('TokenMigrationItems'))).toContain(
      'archivedStates:[ARCHIVED,NOT_ARCHIVED]',
    )
    expect(
      f.queries.find((query) => query.includes('TokenMigrationItems')),
    ).not.toContain('states:')
    const result = await applyTokenMigration(f.client, f.client, snapshot, false, false)
    expect(result.deletions).toHaveLength(TOKEN_DELETION_TARGETS.length)
    expect(f.operations).toEqual([])
  })
  it('retries uncertain evidence publication, partial projection, and partial deletion without losing sources or duplicating totals', async () => {
    const f = fixture()
    const snapshot = await readTokenMigrationSnapshot(f.client, f.client)
    f.fail('append')
    await expect(
      applyTokenMigration(f.client, f.client, snapshot, true, false),
    ).rejects.toThrow()
    expect(f.operations).toEqual(['append'])
    f.fail('project')
    await expect(
      applyTokenMigration(f.client, f.client, snapshot, true, false),
    ).rejects.toThrow()
    expect(f.comments).toHaveLength(1)
    expect(f.fields.some((field) => field.id === f.lifecycle)).toBe(true)
    f.fail(undefined)
    await applyTokenMigration(f.client, f.client, snapshot, true, false)
    expect(f.values.get(TOKEN_FIELD_TARGETS[2].id)).toBe(100)
    const operations = f.operations.length
    await applyTokenMigration(f.client, f.client, snapshot, true, false)
    expect(f.operations).toHaveLength(operations)
    f.comments.push({
      body: serializeTokenReceipt({
        schema: 3,
        issue: 1,
        receipt: 'a'.repeat(64),
        provider: 'codex',
        phase: 'implementation',
        tokens: 20,
      }),
      author: { login: 'jarmak-personal' },
      createdAt: 'later',
      updatedAt: 'later',
    })
    f.values.set(TOKEN_FIELD_TARGETS[1].id, 95)
    f.values.set(TOKEN_FIELD_TARGETS[2].id, 120)
    f.fail('delete')
    await expect(
      applyTokenMigration(f.client, f.client, snapshot, true, true),
    ).rejects.toThrow()
    f.fail(undefined)
    await applyTokenMigration(f.client, f.client, snapshot, true, true)
    expect(f.fields.map((row) => row.name).sort()).toEqual([
      'Implementation tokens',
      'Planning tokens',
      'Title',
      'Total tokens',
    ])
    expect(f.comments).toHaveLength(2)
    expect(f.comments[0]?.body).toContain(f.lifecycle)
    expect(f.values.get(TOKEN_FIELD_TARGETS[2].id)).toBe(120)
  })
  it('rejects changed source values before preserving or overwriting anything', async () => {
    const f = fixture()
    const snapshot = await readTokenMigrationSnapshot(f.client, f.client)
    f.values.set(f.lifecycle, 200)
    await expect(
      applyTokenMigration(f.client, f.client, snapshot, true, true),
    ).rejects.toThrow('Source Project values changed')
    expect(f.operations).toEqual([])
  })
})
