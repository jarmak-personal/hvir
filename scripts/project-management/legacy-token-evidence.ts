import { validTokenCount, type TokenTotals } from './session-token-allocation.ts'

export interface LegacyTokenEvidence {
  key: string
  run: string
  phase: string
  supersedes?: string
  tokens: number | null
}

/** Read-only recovery of the retired v1 counter contract; no retired writer is restored. */
export function parseLegacyTokenEvidence(
  body: string,
  issue: number,
): LegacyTokenEvidence {
  if (Buffer.byteLength(body) > 32768) throw new Error('Legacy evidence too large.')
  const match =
    /^<!-- hvir-agent-work-measurement:v1 -->\n\n```json\n([\s\S]+)\n```$/.exec(body)
  const row = JSON.parse(match?.[1] ?? '') as Record<string, unknown>
  const allowed = [
    'schema',
    'issueNumber',
    'phase',
    'runKey',
    'idempotencyKey',
    'availability',
    'route',
    'usage',
    'timing',
    'missingFacts',
    'unavailableReason',
    'outcome',
    'supersedes',
  ]
  if (
    !row ||
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    row.schema !== 1 ||
    row.issueNumber !== issue ||
    ![
      'issue-planning',
      'implementation',
      'implementation-review',
      'epic-coordination',
    ].includes(String(row.phase)) ||
    !['complete', 'partial', 'unavailable'].includes(String(row.availability)) ||
    !/^[a-f0-9]{64}$/.test(String(row.runKey)) ||
    !/^[a-f0-9]{64}$/.test(String(row.idempotencyKey)) ||
    (row.supersedes !== undefined &&
      (typeof row.supersedes !== 'string' || !/^[a-f0-9]{64}$/.test(row.supersedes)))
  )
    throw new Error('Invalid legacy evidence.')
  const usage = row.usage as Record<string, unknown> | undefined
  let tokens: number | null = null
  if (usage) {
    const additive = [
      'freshInputTokens',
      'cacheReadInputTokens',
      'cacheWriteInputTokens',
      'outputTokens',
    ]
    if (
      Object.keys(usage).some(
        (key) => ![...additive, 'reasoningTokens', 'normalizedTokenTotal'].includes(key),
      ) ||
      Object.values(usage).some((value) => !validTokenCount(value))
    )
      throw new Error('Invalid legacy counters.')
    const parts = additive.map((name) => usage[name]).filter(validTokenCount)
    if (usage.normalizedTokenTotal !== undefined)
      tokens = usage.normalizedTokenTotal as number
    else if (parts.length) tokens = parts.reduce((sum, value) => sum + value, 0)
    if (tokens !== null && !validTokenCount(tokens))
      throw new Error('Legacy counter overflow.')
  }
  return {
    key: String(row.idempotencyKey),
    run: String(row.runKey),
    phase: String(row.phase),
    ...(row.supersedes === undefined ? {} : { supersedes: row.supersedes }),
    tokens,
  }
}

export function recoverLegacyTokenTotals(
  records: readonly LegacyTokenEvidence[],
): TokenTotals {
  const keys = new Map<string, LegacyTokenEvidence>()
  const active = new Map<string, LegacyTokenEvidence>()
  for (const record of records) {
    const previous = keys.get(record.key)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error('Conflicting legacy record.')
      continue
    }
    const identity = `${record.phase}:${record.run}`
    const predecessor = active.get(identity)
    if (record.supersedes ? predecessor?.key !== record.supersedes : !!predecessor)
      throw new Error('Invalid legacy supersession.')
    keys.set(record.key, record)
    active.set(identity, record)
  }
  const rows = [...active.values()].filter((row) => row.tokens !== null)
  if (!rows.length) return { tokens: null, planning: null, implementation: null }
  const planning = rows
    .filter((row) => row.phase === 'issue-planning')
    .reduce((sum, row) => sum + row.tokens!, 0)
  const implementation = rows
    .filter((row) => row.phase !== 'issue-planning')
    .reduce((sum, row) => sum + row.tokens!, 0)
  if (!validTokenCount(planning + implementation))
    throw new Error('Legacy counter overflow.')
  return { tokens: planning + implementation, planning, implementation }
}
