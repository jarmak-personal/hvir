type ActionInputType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
/** Deliberately bounded JSON Schema subset; descriptions are untrusted declaration data. */
export interface ExtensionActionInputSchema {
  readonly type: ActionInputType | readonly ActionInputType[]
  readonly properties?: Readonly<Record<string, ExtensionActionInputSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: false
  readonly items?: ExtensionActionInputSchema
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly maxLength?: number
  readonly maxItems?: number
}
export function validateActionSchema(
  value: unknown,
  depth = 0,
): ExtensionActionInputSchema {
  if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid bounded action input schema')
  const schema = value as Record<string, unknown>
  const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']]
  if (!types.length || types.length > 6 || new Set(types).size !== types.length)
    throw new Error('Unsupported action input types')
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > 2048 ||
    Object.keys(schema).some(
      (key) =>
        ![
          'type',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'enum',
          'maxLength',
          'maxItems',
        ].includes(key),
    ) ||
    types.some(
      (type) =>
        !['object', 'array', 'string', 'number', 'boolean', 'null'].includes(
          type as string,
        ),
    )
  )
    throw new Error('Unsupported action input schema')
  if (schema['properties'] !== undefined) {
    if (
      !types.includes('object') ||
      !schema['properties'] ||
      typeof schema['properties'] !== 'object' ||
      Array.isArray(schema['properties']) ||
      Object.keys(schema['properties']).length > 32
    )
      throw new Error('Invalid action properties')
    for (const [key, child] of Object.entries(schema['properties'])) {
      if (
        !/^[\w-]{1,64}$/u.test(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)
      )
        throw new Error('Invalid action property')
      validateActionSchema(child, depth + 1)
    }
  }
  if (
    schema['required'] !== undefined &&
    (!Array.isArray(schema['required']) ||
      schema['required'].length > 32 ||
      schema['required'].some(
        (key) =>
          typeof key !== 'string' || !Object.hasOwn(schema['properties'] ?? {}, key),
      ))
  )
    throw new Error('Invalid required action properties')
  if (
    schema['additionalProperties'] !== undefined &&
    (!types.includes('object') || schema['additionalProperties'] !== false)
  )
    throw new Error('Invalid additional action properties')
  if (schema['items'] !== undefined) {
    if (!types.includes('array')) throw new Error('Invalid action items')
    validateActionSchema(schema['items'], depth + 1)
  }
  if (
    schema['enum'] !== undefined &&
    (!Array.isArray(schema['enum']) ||
      !schema['enum'].length ||
      schema['enum'].length > 16 ||
      schema['enum'].some(
        (entry) =>
          entry !== null && !['string', 'number', 'boolean'].includes(typeof entry),
      ))
  )
    throw new Error('Invalid action enumeration')
  for (const key of ['maxLength', 'maxItems'])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== 'number' ||
        !Number.isInteger(schema[key]) ||
        schema[key] < 0 ||
        schema[key] > 8192)
    )
      throw new Error('Invalid action input bound')
  return JSON.parse(JSON.stringify(value)) as ExtensionActionInputSchema
}
export function validateActionInput(
  value: unknown,
  schema: ExtensionActionInputSchema,
): void {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (!types.includes(type) || (type === 'number' && !Number.isFinite(value)))
    throw new Error('Action input does not match its declared schema')
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null))
    throw new Error('Action input is not a declared value')
  if (
    typeof value === 'string' &&
    schema.maxLength !== undefined &&
    value.length > schema.maxLength
  )
    throw new Error('Action text exceeds its bound')
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new Error('Action list exceeds its bound')
    if (schema.items) for (const entry of value) validateActionInput(entry, schema.items)
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key))
        throw new Error('Action input is missing a required field')
    for (const [key, entry] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties ?? {}, key)
        ? schema.properties![key]
        : undefined
      if (child) validateActionInput(entry, child)
      else if (schema.additionalProperties === false)
        throw new Error('Action input has an undeclared field')
    }
  }
}
