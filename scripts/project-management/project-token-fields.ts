import type { CanonicalProjectItem } from './canonical-project-item.ts'
import {
  clearCanonicalField,
  requireCanonicalValueField,
  setCanonicalNumber,
  setCanonicalText,
  type CanonicalProjectSchema,
} from './canonical-project-fields.ts'
import { GitHubClient } from './github-client.ts'
import { TOKEN_SCOPE } from './session-token-receipts.ts'

export async function projectRecordedTokens(input: {
  client: GitHubClient
  schema: CanonicalProjectSchema
  item: CanonicalProjectItem | undefined
  tokens: number | null
}): Promise<void> {
  if (!input.item || input.item.archived)
    throw new Error('Token Project item unavailable.')
  const tokens = requireCanonicalValueField(
    input.schema,
    'Recorded tokens',
    'number',
    'contributor tokens',
  )
  const scope = requireCanonicalValueField(
    input.schema,
    'Token scope',
    'text',
    'contributor tokens',
  )
  if (input.tokens !== null && (!Number.isSafeInteger(input.tokens) || input.tokens < 0))
    throw new Error('Invalid tokens.')
  // Read before writing so a repeated capture converges without redundant mutations.
  const data: {
    node: { tokens: { number: number } | null; scope: { text: string } | null } | null
  } = await input.client.graphql(
    `query RecordedTokenFields($item:ID!) {
      node(id:$item) { ... on ProjectV2Item {
        tokens:fieldValueByName(name:"Recorded tokens") { ... on ProjectV2ItemFieldNumberValue { number } }
        scope:fieldValueByName(name:"Token scope") { ... on ProjectV2ItemFieldTextValue { text } }
      } }
    }`,
    { item: input.item.id },
  )
  if (!data.node) throw new Error('Token Project item unavailable.')
  // Label before publishing a value; an interrupted update cannot show an unexplained new total.
  if (data.node.scope?.text !== TOKEN_SCOPE) {
    await setCanonicalText(
      input.client,
      input.schema.id,
      input.item.id,
      scope.id,
      TOKEN_SCOPE,
    )
  }
  if ((data.node.tokens?.number ?? null) === input.tokens) return
  if (input.tokens === null)
    await clearCanonicalField(input.client, input.schema.id, input.item.id, tokens.id)
  else
    await setCanonicalNumber(
      input.client,
      input.schema.id,
      input.item.id,
      tokens.id,
      input.tokens,
    )
}
