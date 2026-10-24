import { parseAllDocuments } from 'yaml'

export type StructuredDataFormat = 'json' | 'yaml'

export function parseStructuredData(
  source: string,
  format: StructuredDataFormat,
): unknown {
  if (format === 'json') return JSON.parse(source) as unknown
  const documents = parseAllDocuments(source)
  const errors = documents.flatMap((document) => document.errors)
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join('\n'))
  }
  const values = documents.map(
    (document) => document.toJS({ mapAsMap: false, maxAliasCount: 100 }) as unknown,
  )
  if (values.length <= 1) return values[0] ?? null
  return Object.fromEntries(
    values.map((value, index) => [`document ${index + 1}`, value]),
  )
}

export type JsonLineRecord =
  | { readonly line: number; readonly value: unknown; readonly error?: never }
  | { readonly line: number; readonly error: string; readonly value?: never }

/** A final line terminator is not a record; blank records elsewhere are invalid. */
export function parseJsonLines(source: string): readonly JsonLineRecord[] {
  if (source.length === 0) return []
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((text, index) => {
    try {
      return { line: index + 1, value: JSON.parse(text) as unknown }
    } catch {
      // Avoid copying an unbounded source fragment from an engine's error message.
      return { line: index + 1, error: 'Invalid JSON record' }
    }
  })
}
