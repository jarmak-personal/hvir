import { pathToFileURL } from 'node:url'
import {
  CANONICAL_PROJECT_CONFIGURATION,
  LEGACY_PROJECT_FIELDS,
} from './canonical-project-config.ts'
import { GitHubClient } from './github-client.ts'
import { nextPageCursor, type PageInfo } from './github-pagination.ts'

export interface RetiredField {
  id: string
  name: string
}

export function planMeasurementRetirement(fields: readonly RetiredField[]): {
  changes: { id: string; from: string; to: string }[]
  diagnostics: string[]
} {
  const changes: { id: string; from: string; to: string }[] = []
  const diagnostics: string[] = []
  for (const expected of LEGACY_PROJECT_FIELDS) {
    const field = fields.find((row) => row.id === expected.id)
    const to = `Legacy: ${expected.name}`
    if (
      !field ||
      (field.name !== expected.name && field.name !== to) ||
      fields.some(
        (row) =>
          row.id !== expected.id && (row.name === to || row.name === expected.name),
      )
    ) {
      diagnostics.push(`field-retirement-conflict:${expected.name}`)
    } else if (field.name !== to) changes.push({ id: field.id, from: field.name, to })
  }
  return { changes, diagnostics }
}

export async function retireProjectMeasurements(
  client: GitHubClient,
  apply: boolean,
): Promise<{
  apply: boolean
  operations: { from: string; to: string; outcome: string }[]
  diagnostics: string[]
}> {
  const fields: RetiredField[] = []
  let after: string | null = null
  do {
    const data: {
      node: { fields: { nodes: RetiredField[]; pageInfo: PageInfo } } | null
    } = await client.graphql(
      `query RetiredProjectFields($id:ID!,$after:String) {
        node(id:$id) { ... on ProjectV2 { fields(first:100,after:$after) {
          nodes { ... on ProjectV2FieldCommon { id name } }
          pageInfo { endCursor hasNextPage }
        } } }
      }`,
      { id: CANONICAL_PROJECT_CONFIGURATION.id, after },
    )
    if (!data.node) throw new Error('Canonical Project unavailable.')
    fields.push(...data.node.fields.nodes)
    after = nextPageCursor(data.node.fields.pageInfo)
  } while (after !== null)
  const plan = planMeasurementRetirement(fields)
  const report = {
    apply,
    operations: [] as { from: string; to: string; outcome: string }[],
    diagnostics: plan.diagnostics,
  }
  if (plan.diagnostics.length) return report
  for (const change of plan.changes) {
    if (apply) {
      try {
        await client.graphql(
          `mutation RetireProjectField($id:ID!,$name:String!) {
          updateProjectV2Field(input:{fieldId:$id,name:$name}) { projectV2Field { ... on ProjectV2FieldCommon { id name } } }
        }`,
          { id: change.id, name: change.to },
        )
      } catch {
        report.diagnostics.push('field-retirement-failed')
        break
      }
    }
    report.operations.push({
      from: change.from,
      to: change.to,
      outcome: apply ? 'renamed' : 'would-rename',
    })
  }
  return report
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new Error('Invalid retirement arguments.')
  const report = await retireProjectMeasurements(
    new GitHubClient({
      token: process.env.HVIR_PROJECT_TOKEN ?? '',
      purpose: 'Project',
    }),
    args.includes('--apply'),
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.diagnostics.length) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Project field retirement unavailable.\n')
    process.exitCode = 1
  })
}
