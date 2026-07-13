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
  const values = documents.map((document) =>
    document.toJS({ mapAsMap: false, maxAliasCount: 100 }) as unknown,
  )
  if (values.length <= 1) return values[0] ?? null
  return Object.fromEntries(
    values.map((value, index) => [`document ${index + 1}`, value]),
  )
}
