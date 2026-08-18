import {
  AGENT_WORK_PROJECT_FIELDS,
  AgentWorkProjectWriteError,
  agentWorkProjectField,
  type AgentWorkProjectFieldName,
  type AgentWorkProjectValue,
  type AgentWorkProjectValues,
} from './agent-work-project-fields.ts'
import type { CanonicalProjectItem } from './canonical-project.ts'
import {
  CanonicalProjectSchemaError,
  clearCanonicalField,
  requireCanonicalSingleSelectField,
  requireCanonicalValueField,
  setCanonicalNumber,
  setCanonicalSingleSelect,
  setCanonicalText,
  type CanonicalProjectSchema,
} from './canonical-project-fields.ts'
import { GitHubClient, GitHubRequestError } from './github-client.ts'

const AGENT_WORK_ITEM_FIELDS = AGENT_WORK_PROJECT_FIELDS.map(
  (field, index) => `
    measurement${index}: fieldValueByName(name: ${JSON.stringify(field.name)}) {
      __typename
      ... on ProjectV2ItemFieldNumberValue { number }
      ... on ProjectV2ItemFieldTextValue { text }
      ... on ProjectV2ItemFieldSingleSelectValue { name }
    }
  `,
).join('\n')

export async function readAgentWorkProjectValues(input: {
  client: GitHubClient
  schema: CanonicalProjectSchema
  item: CanonicalProjectItem | undefined
  issueNumber: number
}): Promise<AgentWorkProjectValues> {
  requireAgentWorkFields(input.schema)
  const item = requireActiveItem(input.item, input.issueNumber)
  const data: {
    node: ({ __typename: string } & Record<string, unknown>) | null
  } = await input.client.graphql(
    `query AgentWorkProjectValues($itemId: ID!) {
      node(id: $itemId) {
        __typename
        ... on ProjectV2Item { ${AGENT_WORK_ITEM_FIELDS} }
      }
    }`,
    { itemId: item.id },
  )
  if (data.node?.__typename !== 'ProjectV2Item') {
    throw new Error(
      `The Project item for issue #${input.issueNumber} could not be read for agent-work projection.`,
    )
  }
  const values: AgentWorkProjectValues = {}
  for (const [index, field] of AGENT_WORK_PROJECT_FIELDS.entries()) {
    const value = parseAgentWorkProjectValue(
      data.node[`measurement${index}`],
      field.name,
      field.type,
    )
    if (value !== undefined) values[field.name] = value
  }
  return values
}

export async function setAgentWorkProjectValue(input: {
  client: GitHubClient
  schema: CanonicalProjectSchema
  item: CanonicalProjectItem | undefined
  issueNumber: number
  name: AgentWorkProjectFieldName
  value: AgentWorkProjectValue | undefined
}): Promise<void> {
  try {
    await setAgentWorkProjectValueUnchecked(input)
  } catch (error) {
    throw new AgentWorkProjectWriteError(projectWriteFailure(error))
  }
}

async function setAgentWorkProjectValueUnchecked(input: {
  client: GitHubClient
  schema: CanonicalProjectSchema
  item: CanonicalProjectItem | undefined
  issueNumber: number
  name: AgentWorkProjectFieldName
  value: AgentWorkProjectValue | undefined
}): Promise<void> {
  const fields = requireAgentWorkFields(input.schema)
  const item = requireActiveItem(input.item, input.issueNumber)
  const field = fields.get(input.name)!
  if (input.value === undefined) {
    await clearCanonicalField(input.client, input.schema.id, item.id, field.id)
    return
  }
  const definition = agentWorkProjectField(input.name)
  if (definition.type === 'number') {
    if (
      typeof input.value !== 'number' ||
      !Number.isSafeInteger(input.value) ||
      input.value < 0
    ) {
      throw new Error(`Unexpected numeric Project value for "${input.name}".`)
    }
    await setCanonicalNumber(
      input.client,
      input.schema.id,
      item.id,
      field.id,
      input.value,
    )
    return
  }
  if (typeof input.value !== 'string') {
    throw new Error(`Unexpected text Project value for "${input.name}".`)
  }
  if (definition.type === 'text') {
    await setCanonicalText(input.client, input.schema.id, item.id, field.id, input.value)
    return
  }
  await setCanonicalSingleSelect(
    input.client,
    input.schema.id,
    item.id,
    { id: field.id, options: field.options ?? [] },
    input.value,
  )
}

function requireActiveItem(
  item: CanonicalProjectItem | undefined,
  issueNumber: number,
): CanonicalProjectItem {
  if (item === undefined) {
    throw new CanonicalProjectSchemaError(
      `Issue #${issueNumber} is missing from the canonical Project.`,
    )
  }
  if (item.archived) {
    throw new CanonicalProjectSchemaError(
      `Issue #${issueNumber} is archived in the canonical Project and cannot receive agent-work projections.`,
    )
  }
  return item
}

function requireAgentWorkFields(
  context: CanonicalProjectSchema,
): Map<
  AgentWorkProjectFieldName,
  { id: string; options?: Array<{ id: string; name: string }> }
> {
  const result = new Map<
    AgentWorkProjectFieldName,
    { id: string; options?: Array<{ id: string; name: string }> }
  >()
  for (const definition of AGENT_WORK_PROJECT_FIELDS) {
    if (definition.type === 'single-select') {
      result.set(
        definition.name,
        requireCanonicalSingleSelectField(
          context,
          definition.name,
          definition.options,
          'agent-work measurement',
        ),
      )
      continue
    }
    result.set(
      definition.name,
      requireCanonicalValueField(
        context,
        definition.name,
        definition.type,
        'agent-work measurement',
      ),
    )
  }
  return result
}

function projectWriteFailure(
  error: unknown,
): 'permission' | 'schema' | 'transport' | 'generic' {
  if (error instanceof CanonicalProjectSchemaError) return 'schema'
  if (error instanceof GitHubRequestError) {
    if (error.failure === 'permission') return 'permission'
    return error.failure === 'transport' ? 'transport' : 'schema'
  }
  return 'generic'
}

function parseAgentWorkProjectValue(
  value: unknown,
  name: AgentWorkProjectFieldName,
  type: 'number' | 'text' | 'single-select',
): AgentWorkProjectValue | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') {
    throw new Error(`Project field "${name}" returned an invalid value.`)
  }
  const record = value as Record<string, unknown>
  // Reads retain finite manual drift so the stricter write path can replace or clear it.
  if (
    type === 'number' &&
    record.__typename === 'ProjectV2ItemFieldNumberValue' &&
    typeof record.number === 'number' &&
    Number.isFinite(record.number)
  ) {
    return record.number
  }
  if (
    type === 'text' &&
    record.__typename === 'ProjectV2ItemFieldTextValue' &&
    typeof record.text === 'string'
  ) {
    return record.text
  }
  if (
    type === 'single-select' &&
    record.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
    typeof record.name === 'string'
  ) {
    return record.name
  }
  throw new Error(`Project field "${name}" returned a value of the wrong type.`)
}
