import { GitHubClient } from './github-client.ts'

export interface CanonicalProjectField {
  typename: string
  id?: string
  name?: string
  dataType?: string
  options?: Array<{ id: string; name: string }>
}

export interface CanonicalProjectSchema {
  id: string
  fields: CanonicalProjectField[]
}

export class CanonicalProjectSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalProjectSchemaError'
  }
}

export type CanonicalSingleSelectField = {
  id: string
  options: Array<{ id: string; name: string }>
}

export function requireCanonicalSingleSelectField(
  context: CanonicalProjectSchema,
  name: string,
  expectedOptions: readonly string[],
  missingSchema: 'single-select' | 'agent-work measurement',
): CanonicalSingleSelectField {
  const field = requireUniqueField(context, name, missingSchema)
  if (field.typename !== 'ProjectV2SingleSelectField' || field.options === undefined) {
    throw new CanonicalProjectSchemaError(
      `Project field "${name}" exists but is not a single-select field.`,
    )
  }
  const available = new Set(field.options.map((option) => option.name))
  for (const option of expectedOptions) {
    if (!available.has(option)) {
      throw new CanonicalProjectSchemaError(
        `Project field "${name}" is missing the expected "${option}" option. Reconcile the documented schema before retrying.`,
      )
    }
  }
  return { id: field.id, options: field.options }
}

export function requireCanonicalValueField(
  context: CanonicalProjectSchema,
  name: string,
  type: 'number' | 'text',
  missingSchema: 'agent-work measurement',
): { id: string } {
  const field = requireUniqueField(context, name, missingSchema)
  const expectedDataType = type === 'number' ? 'NUMBER' : 'TEXT'
  if (field.typename !== 'ProjectV2Field' || field.dataType !== expectedDataType) {
    throw new CanonicalProjectSchemaError(
      `Project field "${name}" exists but is not a ${type} field.`,
    )
  }
  return { id: field.id }
}

export async function setCanonicalSingleSelect(
  client: GitHubClient,
  projectId: string,
  itemId: string,
  field: CanonicalSingleSelectField,
  value: string,
): Promise<void> {
  const optionId = field.options.find((option) => option.name === value)?.id
  if (optionId === undefined) {
    throw new CanonicalProjectSchemaError(
      `Unexpected Project option after schema validation: "${value}".`,
    )
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
    { projectId, itemId, fieldId: field.id, optionId },
  )
}

export async function setCanonicalNumber(
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

export async function setCanonicalText(
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

export async function clearCanonicalField(
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

function requireUniqueField(
  context: CanonicalProjectSchema,
  name: string,
  missingSchema: 'single-select' | 'agent-work measurement',
): CanonicalProjectField & { id: string } {
  const matches = context.fields.filter((field) => field.name === name)
  if (matches.length === 0) {
    throw new CanonicalProjectSchemaError(
      `Project field "${name}" is missing. Reconcile the documented ${missingSchema} schema before retrying.`,
    )
  }
  if (matches.length > 1) {
    throw new CanonicalProjectSchemaError(
      `The canonical Project has more than one field named "${name}".`,
    )
  }
  const field = matches[0]!
  if (field.id === undefined) {
    throw new CanonicalProjectSchemaError(
      `Project field "${name}" has no usable identity.`,
    )
  }
  return { ...field, id: field.id }
}
