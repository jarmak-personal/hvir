import {
  parseLegacyTokenEvidence,
  type LegacyTokenEvidence,
} from './legacy-token-evidence.ts'
import {
  TOKEN_MIGRATION_MARKER,
  parseTokenMigration,
  type TokenMigrationReceipt,
} from './contributor-token-migration.ts'
import type { TokenPhase, TokenTotals } from './session-token-allocation.ts'
/** Immutable observations; one opaque session contribution is counted once. */
export const SESSION_TOKEN_MARKER = '<!-- hvir-session-tokens:v2 -->'
export const LEGACY_TOKEN_MARKER = '<!-- hvir-agent-work-measurement:v1 -->'
export const TOKEN_SCOPE =
  'Observed attributed usage; missing phase evidence remains unknown'

export interface SessionTokenReceipt {
  schema: 2 | 3
  phase?: TokenPhase
  issue: number
  receipt: string
  provider: 'codex' | 'claude-code'
  tokens: number
}

export interface TokenComment {
  body: string
  authorLogin: string | null
  createdAt: string
  updatedAt: string
}

export interface TokenReceiptHistory {
  receipts: SessionTokenReceipt[]
  legacyEvidence?: LegacyTokenEvidence[]
  legacyDiagnostics?: string[]
  migrations?: TokenMigrationReceipt[]
  legacy: boolean
  diagnostics: string[]
}

export interface TokenReceiptPort {
  read: (issue: number) => Promise<TokenReceiptHistory>
  append: (receipt: SessionTokenReceipt) => Promise<void>
}

export function isSessionTokenReceipt(value: unknown): value is SessionTokenReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    ((row.schema === 2 &&
      Object.keys(row).sort().join(',') === 'issue,provider,receipt,schema,tokens') ||
      (row.schema === 3 &&
        Object.keys(row).sort().join(',') ===
          'issue,phase,provider,receipt,schema,tokens' &&
        ['planning', 'implementation', 'unknown'].includes(row.phase as string))) &&
    positiveInteger(row.issue) &&
    typeof row.receipt === 'string' &&
    /^[a-f0-9]{64}$/.test(row.receipt) &&
    (row.provider === 'codex' || row.provider === 'claude-code') &&
    typeof row.tokens === 'number' &&
    Number.isSafeInteger(row.tokens) &&
    row.tokens >= 0
  )
}

export function serializeTokenReceipt(receipt: SessionTokenReceipt): string {
  if (!isSessionTokenReceipt(receipt)) throw new Error('Invalid token receipt.')
  return `${receipt.schema === 2 ? SESSION_TOKEN_MARKER : '<!-- hvir-session-tokens:v3 -->'}\n\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``
}

export function readTokenReceipts(
  issue: number,
  trustedActor: string,
  comments: readonly TokenComment[],
): TokenReceiptHistory {
  const receipts: SessionTokenReceipt[] = []
  const diagnostics = new Set<string>()
  let legacy = false
  const migrations: TokenMigrationReceipt[] = []
  const legacyEvidence: LegacyTokenEvidence[] = []
  const legacyDiagnostics: string[] = []
  for (const comment of comments) {
    if (comment.authorLogin?.toLowerCase() !== trustedActor.toLowerCase()) continue
    if (comment.body.startsWith(LEGACY_TOKEN_MARKER)) {
      legacy = true
      try {
        if (comment.createdAt !== comment.updatedAt) throw new Error()
        legacyEvidence.push(parseLegacyTokenEvidence(comment.body, issue))
      } catch {
        legacyDiagnostics.push('legacy-evidence-needs-review')
      }
    }
    if (comment.body.startsWith(TOKEN_MIGRATION_MARKER)) {
      try {
        if (comment.createdAt !== comment.updatedAt) throw new Error()
        const row = parseTokenMigration(comment.body)
        if (row.issue !== issue) throw new Error()
        migrations.push(row)
      } catch {
        diagnostics.add('invalid-token-migration')
      }
      continue
    }
    if (
      !comment.body.startsWith(SESSION_TOKEN_MARKER) &&
      !comment.body.startsWith('<!-- hvir-session-tokens:v3 -->')
    )
      continue
    if (
      comment.createdAt !== comment.updatedAt ||
      Buffer.byteLength(comment.body) > 1024
    ) {
      diagnostics.add('invalid-token-receipt')
      continue
    }
    const match = /^<!-- hvir-session-tokens:v[23] -->\n\n```json\n([^\n]+)\n```$/.exec(
      comment.body,
    )
    try {
      const value: unknown = JSON.parse(match?.[1] ?? '')
      if (
        !isSessionTokenReceipt(value) ||
        value.issue !== issue ||
        !comment.body.startsWith(`<!-- hvir-session-tokens:v${value.schema} -->`)
      )
        throw new Error()
      receipts.push(value)
    } catch {
      diagnostics.add('invalid-token-receipt')
    }
  }
  return {
    receipts,
    legacy,
    diagnostics: [...diagnostics],
    ...(migrations.length ? { migrations } : {}),
    ...(legacyEvidence.length ? { legacyEvidence } : {}),
    ...(legacyDiagnostics.length ? { legacyDiagnostics } : {}),
  }
}

export function totalTokenReceipts(receipts: readonly SessionTokenReceipt[]): {
  tokens: number | null
  contributions: number
  diagnostics: string[]
} {
  const unique = new Map<string, SessionTokenReceipt>()
  for (const receipt of receipts) {
    const previous = unique.get(receipt.receipt)
    if (
      previous &&
      (previous.issue !== receipt.issue ||
        previous.provider !== receipt.provider ||
        previous.schema !== receipt.schema ||
        previous.phase !== receipt.phase ||
        (receipt.schema === 3 && previous.tokens !== receipt.tokens))
    ) {
      return {
        tokens: null,
        contributions: unique.size,
        diagnostics: ['conflicting-session-assignment'],
      }
    }
    if (!previous || receipt.tokens > previous.tokens)
      unique.set(receipt.receipt, receipt)
  }
  let tokens = 0
  for (const receipt of unique.values()) {
    tokens += receipt.tokens
    if (!Number.isSafeInteger(tokens)) {
      return {
        tokens: null,
        contributions: unique.size,
        diagnostics: ['token-total-overflow'],
      }
    }
  }
  return {
    tokens: unique.size ? tokens : null,
    contributions: unique.size,
    diagnostics: [],
  }
}

export async function captureTokenReceipt(
  port: TokenReceiptPort,
  receipt: SessionTokenReceipt,
  apply: boolean,
): Promise<'would-record' | 'recorded' | 'unchanged'> {
  if (!isSessionTokenReceipt(receipt)) throw new Error('Invalid token receipt.')
  const history = await port.read(receipt.issue)
  const matching = history.receipts.filter((row) => row.receipt === receipt.receipt)
  if (
    history.diagnostics.length ||
    matching.some(
      (row) =>
        row.provider !== receipt.provider ||
        row.schema !== receipt.schema ||
        row.phase !== receipt.phase ||
        (receipt.schema === 3 && row.tokens !== receipt.tokens),
    )
  )
    throw new Error('Receipt conflict.')
  if (matching.some((row) => row.tokens >= receipt.tokens)) return 'unchanged'
  if (!apply) return 'would-record'
  await port.append(receipt)
  return 'recorded'
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function phasedTokenReceipts(
  receipts: readonly SessionTokenReceipt[],
): TokenTotals & { contributions: number; diagnostics: string[] } {
  const total = totalTokenReceipts(receipts)
  if (
    total.tokens === null ||
    receipts.some((row) => row.schema === 2 || row.phase === 'unknown')
  )
    return { ...total, planning: null, implementation: null }
  const sum = (phase: TokenPhase) =>
    totalTokenReceipts(receipts.filter((row) => row.phase === phase)).tokens ?? 0
  return { ...total, planning: sum('planning'), implementation: sum('implementation') }
}

/** A migrated issue baseline covers exact receipt maxima, preserving later deltas. */
export function migratedTokenHistory(
  history: TokenReceiptHistory,
): TokenTotals & { contributions: number; diagnostics: string[] } {
  const migrations = [
    ...new Map((history.migrations ?? []).map((r) => [JSON.stringify(r), r])).values(),
  ]
  const invalid = (diagnostic: string) => ({
    tokens: null,
    planning: null,
    implementation: null,
    contributions: 0,
    diagnostics: [diagnostic],
  })
  if (migrations.length > 1) return invalid('conflicting-token-migration')
  const migration = migrations[0]
  const original = phasedTokenReceipts(history.receipts)
  if (!migration) return original
  if (original.diagnostics.length) return original
  const maximum = new Map<string, SessionTokenReceipt>()
  for (const row of history.receipts) {
    const previous = maximum.get(row.receipt)
    if (!previous || row.tokens > previous.tokens) maximum.set(row.receipt, row)
  }
  for (const covered of migration.covered) {
    const row = maximum.get(covered.receipt)
    if (!row || row.tokens < covered.tokens)
      return invalid('migration-covered-receipt-unavailable')
    if (row.tokens === covered.tokens) maximum.delete(covered.receipt)
    else maximum.set(row.receipt, { ...row, tokens: row.tokens - covered.tokens })
  }
  const delta = phasedTokenReceipts([...maximum.values()])
  const tokens =
    migration.tokens === null ? delta.tokens : migration.tokens + (delta.tokens ?? 0)
  if (tokens !== null && !Number.isSafeInteger(tokens))
    return invalid('token-total-overflow')
  const phase = (key: 'planning' | 'implementation') => {
    if (migration.tokens === null) return delta[key]
    if (delta.tokens === null) return migration[key]
    return migration[key] === null || delta[key] === null
      ? null
      : migration[key] + delta[key]
  }
  return {
    tokens,
    planning: phase('planning'),
    implementation: phase('implementation'),
    contributions: original.contributions,
    diagnostics: delta.diagnostics,
  }
}
