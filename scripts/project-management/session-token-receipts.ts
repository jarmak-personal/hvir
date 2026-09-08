/** Immutable observations; one opaque session contribution is counted once. */
export const SESSION_TOKEN_MARKER = '<!-- hvir-session-tokens:v2 -->'
export const LEGACY_TOKEN_MARKER = '<!-- hvir-agent-work-measurement:v1 -->'
export const TOKEN_SCOPE =
  'Observed session-attributed estimate since migration; legacy excluded'

export interface SessionTokenReceipt {
  schema: 2
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
    Object.keys(row).sort().join(',') === 'issue,provider,receipt,schema,tokens' &&
    row.schema === 2 &&
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
  return `${SESSION_TOKEN_MARKER}\n\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``
}

export function readTokenReceipts(
  issue: number,
  trustedActor: string,
  comments: readonly TokenComment[],
): TokenReceiptHistory {
  const receipts: SessionTokenReceipt[] = []
  const diagnostics = new Set<string>()
  let legacy = false
  for (const comment of comments) {
    if (comment.authorLogin?.toLowerCase() !== trustedActor.toLowerCase()) continue
    if (comment.body.startsWith(LEGACY_TOKEN_MARKER)) legacy = true
    if (!comment.body.startsWith(SESSION_TOKEN_MARKER)) continue
    if (
      comment.createdAt !== comment.updatedAt ||
      Buffer.byteLength(comment.body) > 1024
    ) {
      diagnostics.add('invalid-token-receipt')
      continue
    }
    const match = /^<!-- hvir-session-tokens:v2 -->\n\n```json\n([^\n]+)\n```$/.exec(
      comment.body,
    )
    try {
      const value: unknown = JSON.parse(match?.[1] ?? '')
      if (!isSessionTokenReceipt(value) || value.issue !== issue) throw new Error()
      receipts.push(value)
    } catch {
      diagnostics.add('invalid-token-receipt')
    }
  }
  return { receipts, legacy, diagnostics: [...diagnostics] }
}

export function totalTokenReceipts(receipts: readonly SessionTokenReceipt[]): {
  tokens: number | null
  sessions: number
  diagnostics: string[]
} {
  const unique = new Map<string, SessionTokenReceipt>()
  for (const receipt of receipts) {
    const previous = unique.get(receipt.receipt)
    if (
      previous &&
      (previous.issue !== receipt.issue || previous.provider !== receipt.provider)
    ) {
      return {
        tokens: null,
        sessions: unique.size,
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
        sessions: unique.size,
        diagnostics: ['token-total-overflow'],
      }
    }
  }
  return { tokens: unique.size ? tokens : null, sessions: unique.size, diagnostics: [] }
}

export async function captureTokenReceipt(
  port: TokenReceiptPort,
  receipt: SessionTokenReceipt,
  apply: boolean,
): Promise<'would-record' | 'recorded' | 'unchanged'> {
  if (!isSessionTokenReceipt(receipt)) throw new Error('Invalid token receipt.')
  const history = await port.read(receipt.issue)
  const matching = history.receipts.filter((row) => row.receipt === receipt.receipt)
  if (matching.some((row) => row.provider !== receipt.provider))
    throw new Error('Receipt conflict.')
  if (matching.some((row) => row.tokens >= receipt.tokens)) return 'unchanged'
  if (!apply) return 'would-record'
  await port.append(receipt)
  return 'recorded'
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
