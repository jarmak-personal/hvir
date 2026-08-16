import {
  AGENT_WORK_PROJECT_FIELDS,
  agentWorkProjectField,
  type AgentWorkProjectFieldName,
  type AgentWorkProjectValue,
  type AgentWorkProjectValues,
} from './agent-work-project-fields.ts'
import type {
  CanonicalProjectField,
  CanonicalProjectItem,
  CanonicalProjectSchema,
} from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'

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
  const fields = requireAgentWorkFields(input.schema)
  const item = requireActiveItem(input.item, input.issueNumber)
  const field = fields.get(input.name)!
  if (input.value === undefined) {
    await clearField(input.client, input.schema.id, item.id, field.id)
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
    await setNumber(input.client, input.schema.id, item.id, field.id, input.value)
    return
  }
  if (typeof input.value !== 'string') {
    throw new Error(`Unexpected text Project value for "${input.name}".`)
  }
  if (definition.type === 'text') {
    await setText(input.client, input.schema.id, item.id, field.id, input.value)
    return
  }
  await setSingleSelect(
    input.client,
    input.schema.id,
    item.id,
    field.id,
    field.options ?? [],
    input.value,
  )
}

function requireActiveItem(
  item: CanonicalProjectItem | undefined,
  issueNumber: number,
): CanonicalProjectItem {
  if (item === undefined) {
    throw new Error(`Issue #${issueNumber} is missing from the canonical Project.`)
  }
  if (item.archived) {
    throw new Error(
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
    const matches = context.fields.filter((field) => field.name === definition.name)
    if (matches.length === 0) {
      throw new Error(
        `Project field "${definition.name}" is missing. Reconcile the documented agent-work measurement schema before retrying.`,
      )
    }
    if (matches.length > 1) {
      throw new Error(
        `The canonical Project has more than one field named "${definition.name}".`,
      )
    }
    const field = matches[0]!
    if (field.id === undefined) {
      throw new Error(`Project field "${definition.name}" has no usable identity.`)
    }
    if (definition.type === 'single-select') {
      requireSingleSelectField(field, definition.name, definition.options)
      result.set(definition.name, { id: field.id, options: field.options })
      continue
    }
    const expectedDataType = definition.type === 'number' ? 'NUMBER' : 'TEXT'
    if (field.typename !== 'ProjectV2Field' || field.dataType !== expectedDataType) {
      throw new Error(
        `Project field "${definition.name}" exists but is not a ${definition.type} field.`,
      )
    }
    result.set(definition.name, { id: field.id })
  }
  return result
}

function requireSingleSelectField(
  field: CanonicalProjectField,
  name: AgentWorkProjectFieldName,
  expectedOptions: readonly string[],
): asserts field is CanonicalProjectField & {
  id: string
  options: Array<{ id: string; name: string }>
} {
  if (field.typename !== 'ProjectV2SingleSelectField' || field.options === undefined) {
    throw new Error(`Project field "${name}" exists but is not a single-select field.`)
  }
  const available = new Set(field.options.map((option) => option.name))
  for (const option of expectedOptions) {
    if (!available.has(option)) {
      throw new Error(
        `Project field "${name}" is missing the expected "${option}" option. Reconcile the documented schema before retrying.`,
      )
    }
  }
}

async function setSingleSelect(
  client: GitHubClient,
  projectId: string,
  itemId: string,
  fieldId: string,
  options: Array<{ id: string; name: string }>,
  value: string,
): Promise<void> {
  const optionId = options.find((option) => option.name === value)?.id
  if (optionId === undefined) {
    throw new Error(`Unexpected Project option after schema validation: "${value}".`)
  }
  await client.graphql(
    `mutation SetProjectSingleSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: {singleSelectOptionId: $optionId}
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, optionId },
  )
}

async function setNumber(
  client: GitHubClient,
  projectId: string,
  itemId: string,
  fieldId: string,
  value: number,
): Promise<void> {
  await client.graphql(
    `mutation SetProjectNumber($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: {number: $value}
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value },
  )
}

async function setText(
  client: GitHubClient,
  projectId: string,
  itemId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  await client.graphql(
    `mutation SetProjectText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: {text: $value}
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, value },
  )
}

async function clearField(
  client: GitHubClient,
  projectId: string,
  itemId: string,
  fieldId: string,
): Promise<void> {
  await client.graphql(
    `mutation ClearProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId },
  )
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
  if (
    type === 'number' &&
    record.__typename === 'ProjectV2ItemFieldNumberValue' &&
    typeof record.number === 'number' &&
    Number.isSafeInteger(record.number) &&
    record.number >= 0
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
