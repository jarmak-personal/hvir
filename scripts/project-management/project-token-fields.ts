import type { CanonicalProjectItem } from './canonical-project-item.ts'
import {
  requireCanonicalValueField,
  setCanonicalNumber,
  clearCanonicalField,
  type CanonicalProjectSchema,
} from './canonical-project-fields.ts'
import { GitHubClient } from './github-client.ts'
import { validTokenTotals } from './contributor-token-migration.ts'
import type { TokenTotals } from './session-token-allocation.ts'

export async function projectRecordedTokens(input: {
  client: GitHubClient
  schema: CanonicalProjectSchema
  item: CanonicalProjectItem | undefined
  tokens: TokenTotals
}): Promise<void> {
  if (!input.item) throw new Error('Token Project item unavailable.')
  if (!validTokenTotals(input.tokens)) throw new Error('Invalid tokens.')
  const fields = [
    ['Planning tokens', 'planning'],
    ['Implementation tokens', 'implementation'],
    ['Total tokens', 'tokens'],
  ] as const
  const resolved = fields.map(([name, key]) => ({
    name,
    key,
    ...requireCanonicalValueField(input.schema, name, 'number', 'contributor tokens'),
  }))
  const data: {
    node: {
      planning: { number: number } | null
      implementation: { number: number } | null
      tokens: { number: number } | null
    } | null
  } = await input.client.graphql(
    `query RecordedTokenFields($item:ID!) { node(id:$item) { ... on ProjectV2Item {
      planning:fieldValueByName(name:"Planning tokens") { ... on ProjectV2ItemFieldNumberValue { number } }
      implementation:fieldValueByName(name:"Implementation tokens") { ... on ProjectV2ItemFieldNumberValue { number } }
      tokens:fieldValueByName(name:"Total tokens") { ... on ProjectV2ItemFieldNumberValue { number } }
    } } }`,
    { item: input.item.id },
  )
  if (!data.node) throw new Error('Token Project item unavailable.')
  for (const field of resolved) {
    const value = input.tokens[field.key]
    if ((data.node[field.key]?.number ?? null) === value) continue
    if (value === null)
      await clearCanonicalField(input.client, input.schema.id, input.item.id, field.id)
    else
      await setCanonicalNumber(
        input.client,
        input.schema.id,
        input.item.id,
        field.id,
        value,
      )
  }
}
