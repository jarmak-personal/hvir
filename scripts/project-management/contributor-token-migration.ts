import { validTokenCount, type TokenTotals } from './session-token-allocation.ts'

export const TOKEN_MIGRATION_MARKER = '<!-- hvir-token-migration:v1 -->'
export interface TokenMigrationReceipt extends TokenTotals {
  schema: 1
  issue: number
  source: { item: string; values: Record<string, string | number | null> }
  covered: { receipt: string; tokens: number }[]
  evidence: string
}

export function validTokenTotals(value: TokenTotals): boolean {
  if (
    !value ||
    ![value.tokens, value.planning, value.implementation].every(
      (n) => n === null || validTokenCount(n),
    )
  )
    return false
  if (value.tokens === null)
    return value.planning === null && value.implementation === null
  if (value.planning !== null && value.implementation !== null)
    return value.planning + value.implementation === value.tokens
  return (
    (value.planning ?? 0) <= value.tokens && (value.implementation ?? 0) <= value.tokens
  )
}

export function isTokenMigrationReceipt(value: unknown): value is TokenMigrationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as TokenMigrationReceipt
  return (
    Object.keys(row).sort().join(',') ===
      'covered,evidence,implementation,issue,planning,schema,source,tokens' &&
    row.schema === 1 &&
    validTokenCount(row.issue) &&
    row.issue > 0 &&
    validTokenTotals(row) &&
    !!row.source &&
    Object.keys(row.source).sort().join(',') === 'item,values' &&
    typeof row.source.item === 'string' &&
    row.source.item.length < 128 &&
    !!row.source.values &&
    typeof row.source.values === 'object' &&
    !Array.isArray(row.source.values) &&
    Object.values(row.source.values).every(
      (v) =>
        v === null ||
        typeof v === 'string' ||
        (typeof v === 'number' && Number.isFinite(v)),
    ) &&
    typeof row.evidence === 'string' &&
    row.evidence.length > 0 &&
    row.evidence.length <= 4000 &&
    Array.isArray(row.covered) &&
    row.covered.every(
      (r) =>
        Object.keys(r).sort().join(',') === 'receipt,tokens' &&
        /^[a-f0-9]{64}$/.test(r.receipt) &&
        validTokenCount(r.tokens),
    ) &&
    new Set(row.covered.map((r) => r.receipt)).size === row.covered.length
  )
}

export function serializeTokenMigration(row: TokenMigrationReceipt): string {
  if (!isTokenMigrationReceipt(row)) throw new Error('Invalid token migration receipt.')
  const body = `${TOKEN_MIGRATION_MARKER}\n\n\`\`\`json\n${JSON.stringify(row)}\n\`\`\``
  if (Buffer.byteLength(body) > 60000) throw new Error('Migration evidence too large.')
  return body
}

export function parseTokenMigration(body: string): TokenMigrationReceipt {
  const match = /^<!-- hvir-token-migration:v1 -->\n\n```json\n([^\n]+)\n```$/.exec(body)
  const row: unknown = JSON.parse(match?.[1] ?? '')
  if (!isTokenMigrationReceipt(row) || Buffer.byteLength(body) > 60000)
    throw new Error('Invalid token migration evidence.')
  return row
}
